//! Edge TTS: 微软 Edge 浏览器"大声朗读"的神经网络语音合成.
//! 端点要求特定的 Origin / User-Agent 握手头, 浏览器 JS 无法设置, 故在 Rust 侧实现.

use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[path = "edge_gec.rs"]
mod edge_gec;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, handshake::client::Request, Message},
};

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION: &str = "143.0.3650.75";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(45);

/// 2026 年 10 月起服务要求 GEC v2: CS64 + SHA256; 仅改版本前缀仍会返回 403。
fn sec_ms_gec() -> String {
    edge_gec::generate(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn timestamp() -> String {
    // 端点不校验精确格式, ISO 即可
    chrono_lite_now()
}

fn chrono_lite_now() -> String {
    // 避免引入 chrono: 用 SystemTime 粗略生成 RFC3339 风格时间戳
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

fn synthesis_request() -> Result<Request, String> {
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1\
         ?TrustedClientToken={TRUSTED_CLIENT_TOKEN}\
         &Sec-MS-GEC={}\
         &Sec-MS-GEC-Version=2-{CHROMIUM_VERSION}\
         &ConnectionId={connection_id}",
        sec_ms_gec()
    );

    let major = CHROMIUM_VERSION.split('.').next().unwrap_or("143");
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("构造请求失败: {e}"))?;
    let headers = request.headers_mut();
    headers.insert(
        "Origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            .parse()
            .unwrap(),
    );
    headers.insert(
        "User-Agent",
        format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        )
        .parse()
        .unwrap(),
    );
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    Ok(request)
}

async fn synthesize_inner(text: &str, voice: &str, rate_percent: i32) -> Result<Vec<u8>, String> {
    synthesize_with_limits(
        text,
        voice,
        rate_percent,
        synthesis_request()?,
        CONNECT_TIMEOUT,
        SYNTHESIS_TIMEOUT,
    )
    .await
}

/// 总时限同时覆盖握手、发送、接收与关闭; 超时会丢弃连接，避免后台请求一直占用队列。
async fn synthesize_with_limits(
    text: &str,
    voice: &str,
    rate_percent: i32,
    request: Request,
    connect_timeout: Duration,
    synthesis_timeout: Duration,
) -> Result<Vec<u8>, String> {
    tokio::time::timeout(synthesis_timeout, async {
        let (mut ws, _) = tokio::time::timeout(connect_timeout, connect_async(request))
            .await
            .map_err(|_| "连接语音服务超时，请检查网络后重试".to_string())?
            .map_err(|e| format!("连接语音服务失败: {e}"))?;

        let ts = timestamp();
        let config = format!(
            "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
             {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\
             \"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\
             \"outputFormat\":\"{OUTPUT_FORMAT}\"}}}}}}}}"
        );
        ws.send(Message::Text(config.into()))
            .await
            .map_err(|e| format!("发送配置失败: {e}"))?;

        let sign = if rate_percent >= 0 { "+" } else { "" };
        let ssml = format!(
            "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
             <voice name='{voice}'><prosody pitch='+0Hz' rate='{sign}{rate_percent}%' volume='+0%'>\
             {}</prosody></voice></speak>",
            escape_xml(text)
        );
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let ssml_message = format!(
            "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\n\
             X-Timestamp:{ts}\r\nPath:ssml\r\n\r\n{ssml}"
        );
        ws.send(Message::Text(ssml_message.into()))
            .await
            .map_err(|e| format!("发送合成请求失败: {e}"))?;

        let mut audio: Vec<u8> = Vec::new();
        while let Some(frame) = ws.next().await {
            match frame.map_err(|e| format!("接收音频失败: {e}"))? {
                Message::Text(text_frame) => {
                    if text_frame.contains("Path:turn.end") {
                        break;
                    }
                }
                Message::Binary(data) => {
                    if data.len() < 2 {
                        continue;
                    }
                    let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                    if data.len() < 2 + header_len {
                        continue;
                    }
                    let header = String::from_utf8_lossy(&data[2..2 + header_len]);
                    if header.contains("Path:audio") {
                        audio.extend_from_slice(&data[2 + header_len..]);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = ws.close(None).await;

        if audio.is_empty() {
            return Err("语音服务未返回音频".into());
        }
        Ok(audio)
    })
    .await
    .map_err(|_| "语音合成超时，请检查网络后重试".to_string())?
}

/// 合成一段文本, 返回 mp3 字节流
#[tauri::command]
pub async fn edge_tts_synthesize(
    text: String,
    voice: String,
    rate_percent: i32,
) -> Result<tauri::ipc::Response, String> {
    let audio = synthesize_inner(&text, &voice, rate_percent).await?;
    Ok(tauri::ipc::Response::new(audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_uses_matching_v2_token_and_version() {
        let request = synthesis_request().expect("request should be valid");
        let query = request.uri().query().unwrap();
        assert!(query.contains("Sec-MS-GEC-Version=2-143.0.3650.75"));
        let token = query
            .split('&')
            .find_map(|p| p.strip_prefix("Sec-MS-GEC="))
            .unwrap();
        let (cs64, sha256) = token.split_once('-').expect("v2 has both digests");
        assert_eq!(cs64.len(), 16);
        assert_eq!(sha256.len(), 64);
    }

    #[tokio::test]
    async fn stalled_handshake_times_out_and_releases_connection() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let request = format!("ws://{}", listener.local_addr().unwrap())
            .into_client_request()
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Consume the request without replying. EOF confirms the timeout dropped the socket.
            let mut request = Vec::new();
            socket.read_to_end(&mut request).await.unwrap();
            assert!(!request.is_empty());
        });
        let result = synthesize_with_limits(
            "测试",
            "zh-CN-XiaoxiaoNeural",
            0,
            request,
            Duration::from_millis(50),
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(result.unwrap_err(), "连接语音服务超时，请检查网络后重试");
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stalled_audio_times_out_and_releases_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let request = format!("ws://{}", listener.local_addr().unwrap())
            .into_client_request()
            .unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            assert!(ws
                .next()
                .await
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap()
                .contains("Path:speech.config"));
            assert!(ws
                .next()
                .await
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap()
                .contains("Path:ssml"));
            // No turn.end or audio: the client's total timeout must close the socket.
            assert!(!matches!(ws.next().await, Some(Ok(_))));
        });
        let result = synthesize_with_limits(
            "测试",
            "zh-CN-XiaoxiaoNeural",
            0,
            request,
            Duration::from_secs(2),
            Duration::from_millis(100),
        )
        .await;
        assert_eq!(result.unwrap_err(), "语音合成超时，请检查网络后重试");
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires the live Edge TTS service; run explicitly before a release"]
    async fn synthesizes_chinese_mp3() {
        for voice in ["zh-TW-HsiaoChenNeural", "zh-CN-XiaoxiaoNeural"] {
            let audio = synthesize_inner("轻阅语音连接测试。", voice, 0)
                .await
                .expect("synthesis should succeed");
            assert!(audio.len() > 4000, "audio too small: {}", audio.len());
            // MP3 帧同步字 0xFFEx 或 ID3 头
            let is_mp3 = audio[0] == 0xFF || &audio[..3] == b"ID3";
            assert!(is_mp3, "not mp3: {:02X?}", &audio[..4.min(audio.len())]);
            println!("{voice}: {} MP3 bytes", audio.len());
        }
    }
}

// SPDX-License-Identifier: LGPL-3.0-only
// Port of edge-tts 7.3.1 drm.py, Copyright (c) rany <rany@riseup.net>.
// https://github.com/rany2/edge-tts/blob/7.3.1/src/edge_tts/drm.py
// Shared by desktop and mobile: Microsoft requires GEC v2 since October 2026.
// See edge-tts-LICENSE.txt and edge-tts-COPYING.txt for upstream licensing.
const INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const STATE: [u32; 8] = [
    0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x4bd35ab, 0xfeb0a7e4, 0x3effbd2,
];
const SCHEDULE: [u32; 14] = [
    0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0xcfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
    0xf0c31573, 0x7058ce4e, 0x7188e606, 0xe5ab33, 0xd258b060, 0x72766564,
];
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0xfc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x6ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const COEFFICIENTS: [(u32, u32); 14] = [
    (0xe82e91b1, 0xb32700d0),
    (0x44de24c6, 0x88dff51d),
    (0x3beb65bc, 0x29514038),
    (0xc89c5933, 0xb328cbdf),
    (0x8d1ec211, 0xd405b4d5),
    (0x314ef5d5, 0x26e55f3c),
    (0xe92491b1, 0x607801c6),
    (0xf0a5b9d5, 0x82b2c1fb),
    (0x6064cf3, 0xfa51a3da),
    (0xda79fa60, 0x207cc464),
    (0xbed20560, 0x3c3c74f3),
    (0x89f9c9f8, 0xd2d14b61),
    (0x35fa38c6, 0xbb04a2c1),
    (0xcb49e3c6, 0xc5626167),
];
fn sigma0(x: u32) -> u32 {
    x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)
}
fn sigma1(x: u32) -> u32 {
    x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10)
}
fn expand(w: &mut Vec<u32>) {
    for i in w.len()..64 {
        w.push(
            sigma1(w[i - 2])
                .wrapping_add(w[i - 7])
                .wrapping_add(sigma0(w[i - 15]))
                .wrapping_add(w[i - 16]),
        );
    }
}
fn rounds(mut s: [u32; 8], w: &[u32], start: usize) -> [u32; 8] {
    for i in start..64 {
        let [a, b, c, d, e, f, g, h] = s;
        let k = if start == 14 && i == 14 {
            0xC9DC06A7
        } else {
            K[i]
        };
        let t1 = h
            .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
            .wrapping_add(g ^ (e & (f ^ g)))
            .wrapping_add(k)
            .wrapping_add(w[i]);
        let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
            .wrapping_add((a & b) | (c & (a | b)));
        s = [t1.wrapping_add(t2), a, b, c, d.wrapping_add(t1), e, f, g];
    }
    s
}
fn add_state(a: [u32; 8], b: [u32; 8]) -> [u32; 8] {
    std::array::from_fn(|i| a[i].wrapping_add(b[i]))
}
fn digest(data: &[u8]) -> Vec<u8> {
    let mut w = vec![0; 14];
    w.push(u32::from_be_bytes([0, data[0], data[1], data[2]]));
    w.push(u32::from_be_bytes(data[3..7].try_into().unwrap()));
    for i in 16..30 {
        let mut v = SCHEDULE[i - 16];
        if i - 2 >= 14 {
            v = v.wrapping_add(sigma1(w[i - 2]) ^ if i == 16 { 0x000B92C0 } else { 0 });
        }
        if i - 7 >= 14 {
            v = v.wrapping_add(w[i - 7]);
        }
        if i - 15 >= 14 {
            v = v.wrapping_add(sigma0(w[i - 15]) ^ if i == 29 { 0x059C0B80 } else { 0 });
        }
        w.push(v);
    }
    w.push(
        sigma1(w[28])
            .wrapping_add(w[23])
            .wrapping_add(sigma0(w[15]))
            .wrapping_add(w[14])
            .wrapping_add(0xC9DC06A7)
            .wrapping_sub(K[14]),
    );
    expand(&mut w);
    let mut s = add_state(INITIAL, rounds(STATE, &w, 14));
    let len = 57 + data.len();
    let mut padded = data[7..].to_vec();
    padded.push(0x80);
    padded.resize(
        padded.len() + (55i64 - len as i64).rem_euclid(64) as usize,
        0,
    );
    padded.extend_from_slice(&((len as u64) * 8).to_be_bytes());
    for block in padded.chunks_exact(64) {
        let mut w: Vec<u32> = block
            .chunks_exact(4)
            .map(|v| u32::from_be_bytes(v.try_into().unwrap()))
            .collect();
        expand(&mut w);
        s = add_state(s, rounds(s, &w, 0));
    }
    s.iter().flat_map(|v| v.to_be_bytes()).collect()
}
fn cs64(data: &[u8], digest: &[u8]) -> Vec<u8> {
    let a = u32::from_le_bytes(digest[..4].try_into().unwrap()) | 1;
    let b = u32::from_le_bytes(digest[4..8].try_into().unwrap()) | 1;
    let factors = [a.wrapping_mul(0x82893933), b.wrapping_mul(0x82893933)];
    let mut terms: Vec<u32> = COEFFICIENTS
        .iter()
        .enumerate()
        .map(|(i, (v, _))| v.wrapping_mul(factors[i % 2]))
        .collect();
    let mut offsets: Vec<u32> = COEFFICIENTS.iter().map(|(_, v)| *v).collect();
    let mut words = vec![0];
    words.extend_from_slice(data);
    words.resize(words.len().div_ceil(8) * 8, 0);
    for (i, bytes) in words.chunks_exact(4).enumerate() {
        let word = u32::from_le_bytes(bytes.try_into().unwrap());
        let mut term = word.wrapping_mul(if i % 2 == 0 { a } else { b });
        let mut offset =
            word.rotate_left(16)
                .wrapping_mul(if i % 2 == 0 { 0xEF0569FB } else { 0xC31713DB });
        if i == 0 {
            term = term.wrapping_add(0xF2F90B1Au32.wrapping_mul(factors[0]));
            offset = offset.wrapping_add(0x0B1A0000);
        }
        terms.push(term);
        offsets.push(offset);
    }
    let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
    for i in (0..terms.len()).step_by(2) {
        let (x, y) = (terms[i], terms[i + 1]);
        let q = offsets[i]
            .wrapping_add(x)
            .rotate_left(16)
            .wrapping_mul(0x76F50F34);
        swap_acc =
            swap_acc.wrapping_add(q.rotate_left(16).wrapping_mul(0xC3EFEA97).wrapping_add(q));
        let q = offsets[i + 1]
            .wrapping_add(y)
            .rotate_left(16)
            .wrapping_mul(0x1881CE3C);
        swap_last = q.rotate_left(16).wrapping_mul(0x35BD1EC9).wrapping_add(q);
        swap_acc = swap_acc.wrapping_add(swap_last);
        state = state.wrapping_mul(a).wrapping_add(x);
        for factor in [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83] {
            state = state.rotate_left(16).wrapping_mul(factor);
        }
        acc = acc.wrapping_add(state);
        state = state.wrapping_mul(b).wrapping_add(y);
        for factor in [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69] {
            state = state.rotate_left(16).wrapping_mul(factor);
        }
        acc = acc.wrapping_add(state);
    }
    [swap_last ^ state, swap_acc ^ acc]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect()
}
fn hex(data: &[u8]) -> String {
    data.iter().map(|v| format!("{v:02X}")).collect()
}
pub fn generate(unix: u64) -> String {
    let win = unix + 11_644_473_600;
    let ticks = (win - win % 300) * 10_000_000;
    let data = format!("{ticks}6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    let hash = digest(data.as_bytes());
    format!("{}-{}", hex(&cs64(data.as_bytes(), &hash)), hex(&hash))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_edge_tts_731_vectors() {
        assert_eq!(
            generate(0),
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"
        );
        assert_eq!(
            generate(299),
            "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"
        );
        assert_eq!(
            generate(300),
            "F7535A20A262E331-28675BF85C7106BBF20035A78FCB0B6890813EAD5C3B983EF3424931B720BABB"
        );
        assert_eq!(
            generate(1720000000),
            "576EF243D9E6C36D-B73D5ADB984074BAE7860791FCA9CE1D28D1F6678CE5644A7981ACCA7E3C0EF2"
        );
        assert_eq!(
            generate(1792267200),
            "4AB316B3C2C108BA-12ED3CA866D15D5903F49B87FADC09A5D0A100B6A199C96D5B20F22D252A4794"
        );
        assert_eq!(
            generate(2000000000),
            "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E"
        );
    }
    #[test]
    fn matches_captured_edge_token() {
        // Independent capture documented in upstream PR #492.
        assert_eq!(
            generate(1791888000),
            "492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876"
        );
    }
    #[test]
    fn five_minute_window() {
        assert_eq!(generate(0), generate(299));
        assert_ne!(generate(299), generate(300));
    }
}

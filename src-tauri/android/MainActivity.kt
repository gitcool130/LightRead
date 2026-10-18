package com.yzfly.lightread

// 覆盖 `tauri android init` 生成的 MainActivity (CI 在 init 后复制进 gen/android)。
// edge-to-edge 下网页铺到系统栏之下; 旧版 System WebView (如 Android 12 + Chromium 135)
// 不给 env(safe-area-inset-*) 赋值, 这里把系统栏 + 刘海的实际尺寸 (CSS px) 经
// window.LightReadInsets 交给前端 src/services/systemBars.ts; 前端再按页面实际深浅
// 回调 setBarsDark 切换状态栏 / 导航栏图标颜色。

//
// 应用内更新 (window.LightReadUpdater, 前端 src/services/updater.ts): Rust 把校验过的安装包
// 放在 cacheDir/updates/<name>.apk, 这里用 FileProvider (tauri init 自带, cache-path) 交给
// 系统安装器。没开「安装未知应用」时由前端引导到该设置页, 回来后再调 install。
// 清单需要 REQUEST_INSTALL_PACKAGES, 由 scripts/patch-android-project.mjs 在 init 后补上。

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import java.io.File
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var nativeTts: NativeTtsBridge? = null

  @Volatile
  private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Thread { cleanInstalledUpdates() }.start()
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(InsetsBridge(), "LightReadInsets")
    webView.addJavascriptInterface(UpdaterBridge(), "LightReadUpdater")
    nativeTts?.shutdown()
    nativeTts = NativeTtsBridge(this, webView).also {
      webView.addJavascriptInterface(it, "LightReadNativeTts")
    }

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      fun css(px: Int) = px / density
      insetsJson = "{\"top\":${css(bars.top)},\"right\":${css(bars.right)}," +
        "\"bottom\":${css(bars.bottom)},\"left\":${css(bars.left)}}"
      (view as WebView).evaluateJavascript("window.__lightreadApplyInsets?.()", null)
      // 交还 WebView 自身的处理, 新版 Chromium 仍据此填充 env()
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onDestroy() {
    nativeTts?.shutdown()
    nativeTts = null
    super.onDestroy()
  }

  private var barsDark: Boolean? = null

  private fun applyBarsDark(dark: Boolean) {
    if (barsDark == dark) return
    barsDark = dark
    // 透明系统栏, 仅切换图标深浅; 背景由网页自身延伸到栏下
    val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
      else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(style, style)
  }

  /** 沉浸阅读: 隐藏状态栏与导航栏 (从屏幕边缘滑动可临时呼出) */
  private fun applyImmersive(on: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (on) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  private fun applyKeepScreenOn(on: Boolean) {
    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  private inner class InsetsBridge {
    @JavascriptInterface
    fun setImmersive(on: Boolean) {
      runOnUiThread { applyImmersive(on) }
    }

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
      runOnUiThread { applyKeepScreenOn(on) }
    }

    @JavascriptInterface
    fun get(): String = insetsJson

    @JavascriptInterface
    fun setBarsDark(dark: Boolean) {
      runOnUiThread { applyBarsDark(dark) }
    }
  }

  // ---- 应用内更新 ----

  private fun updatesDir() = File(cacheDir, "updates")

  /** Android 8+ 需要用户为本应用打开「安装未知应用」 */
  private fun canInstallPackages(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

  @Suppress("DEPRECATION")
  private fun installedVersionCode(): Long =
    androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))

  /** 删掉已经装上 (或比当前旧) 的安装包, 以及一天前的半截下载 */
  @Suppress("DEPRECATION")
  private fun cleanInstalledUpdates() {
    try {
      val files = updatesDir().listFiles() ?: return
      val current = installedVersionCode()
      val dayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
      for (file in files) {
        val stale = if (file.name.endsWith(".apk")) {
          val info = packageManager.getPackageArchiveInfo(file.path, 0)
          info == null || info.packageName != packageName ||
            androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(info) <= current
        } else {
          file.lastModified() < dayAgo
        }
        if (stale) file.delete()
      }
    } catch (e: Exception) {
      // 清理失败不影响启动
    }
  }

  private inner class UpdaterBridge {
    @JavascriptInterface
    fun canInstall(): Boolean = canInstallPackages()

    /** 打开本应用的「安装未知应用」开关页; 个别系统没有该页时退到应用详情 */
    @JavascriptInterface
    fun openInstallPermission() {
      runOnUiThread {
        val pkg = Uri.parse("package:$packageName")
        try {
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) throw ActivityNotFoundException()
          startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkg))
        } catch (e: Exception) {
          try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
          } catch (e: Exception) {
            // 没有可用的设置页
          }
        }
      }
    }

    /**
     * 打开系统安装器安装 cacheDir/updates/<name> (只接受校验后的 .apk)。
     * 返回 ok / permission (需先开启安装权限) / missing (文件不在) / error
     */
    @JavascriptInterface
    fun install(name: String): String {
      if (!Regex("^[A-Za-z0-9_+-][A-Za-z0-9._+-]*\\.apk$").matches(name)) return "error"
      val file = File(updatesDir(), name)
      if (!file.isFile) return "missing"
      if (!canInstallPackages()) return "permission"
      return try {
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runOnUiThread {
          try {
            startActivity(intent)
          } catch (e: Exception) {
            // 极少见: 系统没有安装器; 用户可在设置页复制链接用浏览器下载
          }
        }
        "ok"
      } catch (e: Exception) {
        "error"
      }
    }
  }
}

/**
 * ssl_unpinning.js - 通用 SSL Pinning 绕过模块（Java 层，多栈覆盖）
 * 用途：一次加载覆盖常见证书校验/固定实现，配合代理抓包（ssl_plaintext 是观测，本模块是绕过）
 * 覆盖：SSLContext+TrustAll TrustManager / OkHttp3（Pinner+HostnameVerifier）/ OkHttp2（com.squareup）/
 *   WebViewClient.onReceivedSslError / HttpsURLConnectionImpl(JSSE) / XUtils3 / httpclientandroidlib /
 *   Conscrypt TrustManagerImpl（verifyChain，缺则退 checkTrusted）/ Conscrypt*Socket（verifyCertificateChain）/
 *   TrustKit / Cronet / Appcelerator PinningTrustManager
 * 加载方式：frida -U -f com.app -l scripts/core/utils.js -l scripts/bypass/ssl_unpinning.js
 * 局限：纯 Java 层；native TLS（OpenSSL/BoringSSL/libcurl）与自研/国密 SDK（GMSSL 等）不覆盖，
 *       对应场景改用 native_hooker（SSL_CTX_set_verify / SSL_set_verify / curl_easy_setopt）或绕开 TLS 走 hook 层
 * 配置：-e 'var CONFIG_OVERRIDE={ssl_unpinning:{quiet:true,verbose:true,hookCronet:false}}'
 */
(function (global) {
    'use strict';

    var U = global.Utils;
    if (!U) { console.log("[-] ssl_unpinning requires utils.js (load it first)"); return; }

    var CONFIG = U.mergeConfig('ssl_unpinning', {
        quiet: false,     // true = 不打拦截日志（仅保留分类安装摘要）
        verbose: false,   // true = 每次拦截都打；false = 每类仅首次命中打一条
        hookSSLContext: true,
        hookOkHttp: true,           // okhttp3 + okhttp2
        hookWebView: true,
        hookHttpsURLConnection: true,
        hookXUtils: true,
        hookHttpClientAndroidLib: true,
        hookConscrypt: true,        // TrustManagerImpl + OpenSSLSocketImpl（两个独立类目）
        hookTrustKit: true,
        hookCronet: true,
        hookAppcelerator: true,
    });

    if (!Java.available) { U.fail("ssl_unpinning: Java not available"); return; }

    var firstHit = {};
    function vlog(cat, msg) {
        if (CONFIG.quiet) return;
        if (CONFIG.verbose || !firstHit[cat]) {
            firstHit[cat] = true;
            U.alert("[SSL_UNPIN:" + cat + "] " + msg);
        }
    }

    function install() {
        Java.perform(function () {
            var active = [];
            var EmptySSLFactory = null;

            function skipMissing(e) {
                var m = String((e && e.message) || e);
                return m.indexOf("ClassNotFoundException") >= 0 || m.indexOf("not found") >= 0;
            }

            function category(name, enabled, fn) {
                if (!enabled) return;
                try {
                    fn();
                    active.push(name);
                    U.ok("[SSL_UNPIN] " + name);
                } catch (e) {
                    if (skipMissing(e)) U.info("[SSL_UNPIN] " + name + " 不存在（跳过）");
                    else U.fail("[SSL_UNPIN] " + name + " hook 失败: " + ((e && e.message) || e));
                }
            }

            // ---------- 1. SSLContext + TrustAll TrustManager（全局兜底） ----------
            category("SSLContext/TrustAll", CONFIG.hookSSLContext, function () {
                var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
                var TrustManager = Java.registerClass({
                    name: 'org.wooyun.TrustManager',
                    implements: [X509TrustManager],
                    methods: {
                        checkClientTrusted: function (chain, authType) { },
                        checkServerTrusted: function (chain, authType) { },
                        getAcceptedIssuers: function () { return []; }
                    }
                });
                var TrustManagers = [TrustManager.$new()];
                var TLS = Java.use('javax.net.ssl.SSLContext').getInstance("TLS");
                TLS.init(null, TrustManagers, null);
                EmptySSLFactory = TLS.getSocketFactory();

                var SSLContext = Java.use('javax.net.ssl.SSLContext');
                var SSLContext_init = SSLContext.init.overload(
                    '[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom');
                SSLContext_init.implementation = function (keyManager, trustManager, secureRandom) {
                    vlog("SSLContext", "SSLContext.init() -> 空 TrustManager");
                    SSLContext_init.call(this, null, TrustManagers, null);
                };
            });

            // ---------- 2. OkHttp3（Pinner + HostnameVerifier） ----------
            category("okhttp3", CONFIG.hookOkHttp, function () {
                var CertificatePinner = Java.use('okhttp3.CertificatePinner');
                CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function () {
                    vlog("okhttp3", "CertificatePinner.check() 放行");
                };

                var HostnameVerifier = Java.use('javax.net.ssl.HostnameVerifier');
                var myHostnameVerifier = Java.registerClass({
                    name: 'com.xiaojianbang.MyHostnameVerifier',
                    implements: [HostnameVerifier],
                    methods: {
                        verify: function (hostname, session) { return true; }
                    }
                });

                var Builder = Java.use('okhttp3.OkHttpClient$Builder');
                Builder.hostnameVerifier.implementation = function () {
                    vlog("okhttp3", "OkHttpClient$Builder.hostnameVerifier() 拦截");
                    return this;
                };

                var OkHttpClient = Java.use('okhttp3.OkHttpClient');
                OkHttpClient.hostnameVerifier.implementation = function () {
                    vlog("okhttp3", "OkHttpClient.hostnameVerifier() -> TrustAll");
                    return myHostnameVerifier.$new();
                };
            });

            // ---------- 3. OkHttp2（com.squareup） ----------
            category("okhttp2", CONFIG.hookOkHttp, function () {
                var OkHttpClient2 = Java.use("com.squareup.okhttp.OkHttpClient");
                OkHttpClient2.setCertificatePinner.implementation = function (certificatePinner) {
                    vlog("okhttp2", "setCertificatePinner() 忽略");
                    return this;
                };
                var CertificatePinner2 = Java.use("com.squareup.okhttp.CertificatePinner");
                CertificatePinner2.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;').implementation = function () {
                    vlog("okhttp2", "CertificatePinner.check() 放行 [Certificate]");
                };
                CertificatePinner2.check.overload('java.lang.String', 'java.util.List').implementation = function () {
                    vlog("okhttp2", "CertificatePinner.check() 放行 [List]");
                };
            });

            // ---------- 4. WebView ----------
            category("WebView", CONFIG.hookWebView, function () {
                var WebViewClient = Java.use("android.webkit.WebViewClient");
                WebViewClient.onReceivedSslError.implementation = function (webView, sslErrorHandler, sslError) {
                    vlog("WebView", "onReceivedSslError -> proceed()");
                    sslErrorHandler.proceed();
                };
                WebViewClient.onReceivedError.overload('android.webkit.WebView', 'int', 'java.lang.String', 'java.lang.String').implementation = function () {
                    vlog("WebView", "onReceivedError(旧签名) 忽略");
                };
                WebViewClient.onReceivedError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError').implementation = function () {
                    vlog("WebView", "onReceivedError(新签名) 忽略");
                };
            });

            // ---------- 5. HttpsURLConnectionImpl（JSSE） ----------
            category("HttpsURLConnection", CONFIG.hookHttpsURLConnection, function () {
                var HttpsURLConnectionImpl = Java.use("com.android.okhttp.internal.huc.HttpsURLConnectionImpl");
                HttpsURLConnectionImpl.setSSLSocketFactory.implementation = function (SSLSocketFactory) {
                    vlog("HttpsURLConnection", "setSSLSocketFactory 拦截");
                };
                HttpsURLConnectionImpl.setHostnameVerifier.implementation = function (hostnameVerifier) {
                    vlog("HttpsURLConnection", "setHostnameVerifier 拦截");
                };
            });

            // ---------- 6. XUtils3 ----------
            category("XUtils", CONFIG.hookXUtils, function () {
                if (!EmptySSLFactory) throw new Error("EmptySSLFactory not ready (需 hookSSLContext=true)");
                var TrustHostnameVerifier = Java.registerClass({
                    name: 'org.wooyun.TrustHostnameVerifier',
                    implements: [Java.use('javax.net.ssl.HostnameVerifier')],
                    methods: {
                        verify: function (hostname, session) { return true; }
                    }
                });
                var RequestParams = Java.use('org.xutils.http.RequestParams');
                RequestParams.setSslSocketFactory.implementation = function (sslSocketFactory) {
                    vlog("XUtils", "setSslSocketFactory -> EmptySSLFactory");
                    sslSocketFactory = EmptySSLFactory;
                };
                RequestParams.setHostnameVerifier.implementation = function (hostnameVerifier) {
                    vlog("XUtils", "setHostnameVerifier -> TrustAll");
                    hostnameVerifier = TrustHostnameVerifier.$new();
                };
            });

            // ---------- 7. httpclientandroidlib ----------
            category("httpclientandroidlib", CONFIG.hookHttpClientAndroidLib, function () {
                var AbstractVerifier = Java.use("ch.boye.httpclientandroidlib.conn.ssl.AbstractVerifier");
                AbstractVerifier.verify.overload('java.lang.String', '[Ljava.lang.String', '[Ljava.lang.String', 'boolean').implementation = function () {
                    vlog("httpclientandroidlib", "AbstractVerifier.verify 放行");
                };
            });

            // ---------- 8a. Conscrypt TrustManagerImpl（verifyChain，缺则退 checkTrusted） ----------
            category("Conscrypt.TrustManagerImpl", CONFIG.hookConscrypt, function () {
                var TrustManagerImpl = null;
                try { TrustManagerImpl = Java.use("com.android.org.conscrypt.TrustManagerImpl"); }
                catch (e1) { TrustManagerImpl = Java.use("org.conscrypt.TrustManagerImpl"); }

                if (TrustManagerImpl.verifyChain !== undefined) {
                    TrustManagerImpl.verifyChain.implementation = function (untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
                        vlog("Conscrypt", "TrustManagerImpl.verifyChain -> 原链放行");
                        return untrustedChain;
                    };
                    return;
                }
                if (TrustManagerImpl.checkTrusted === undefined) {
                    throw new Error("no verifyChain/checkTrusted on TrustManagerImpl");
                }
                var Arrays = Java.use("java.util.Arrays");
                var n = 0;
                TrustManagerImpl.checkTrusted.overloads.forEach(function (ov) {
                    ov.implementation = function () {
                        vlog("Conscrypt", "TrustManagerImpl.checkTrusted 放行");
                        for (var i = 0; i < arguments.length; i++) {
                            var a = arguments[i];
                            try {
                                if (a && String(a.getClass().getName()) === "[Ljava.security.cert.X509Certificate;") {
                                    return Arrays.asList(a);
                                }
                            } catch (e2) { }
                        }
                        return null;
                    };
                    n++;
                });
                if (n === 0) throw new Error("checkTrusted 无重载");
            });

            // ---------- 8b. Conscrypt Socket 证书链（类随版本变化：OpenSSLSocketImpl → Conscrypt*Socket） ----------
            category("Conscrypt.OpenSSLSocketImpl", CONFIG.hookConscrypt, function () {
                var targets = [
                    "com.android.org.conscrypt.OpenSSLSocketImpl",
                    "com.android.org.conscrypt.ConscryptFileDescriptorSocket",
                    "com.android.org.conscrypt.ConscryptEngineSocket",
                ];
                var hooked = 0;
                targets.forEach(function (clsName) {
                    var cls;
                    try { cls = Java.use(clsName); } catch (e) { return; }
                    if (cls.verifyCertificateChain === undefined) return;
                    cls.verifyCertificateChain.implementation = function (certRefs, authMethod) {
                        vlog("Conscrypt", clsName.split('.').pop() + ".verifyCertificateChain 放行");
                    };
                    hooked++;
                });
                if (hooked === 0) throw new Error("no verifyCertificateChain on OpenSSLSocketImpl/Conscrypt*Socket（ROM 版本差异）");
            });

            // ---------- 9. TrustKit ----------
            category("TrustKit", CONFIG.hookTrustKit, function () {
                var OkHostnameVerifier = Java.use("com.datatheorem.android.trustkit.pinning.OkHostnameVerifier");
                OkHostnameVerifier.verify.overload('java.lang.String', 'javax.net.ssl.SSLSession').implementation = function (str) {
                    vlog("TrustKit", "verify(host, session) -> true");
                    return true;
                };
                OkHostnameVerifier.verify.overload('java.lang.String', 'java.security.cert.X509Certificate').implementation = function (str) {
                    vlog("TrustKit", "verify(host, cert) -> true");
                    return true;
                };
            });

            // ---------- 10. Cronet ----------
            category("Cronet", CONFIG.hookCronet, function () {
                var netBuilder = Java.use("org.chromium.net.CronetEngine$Builder");
                netBuilder.enablePublicKeyPinningBypassForLocalTrustAnchors.implementation = function (arg) {
                    vlog("Cronet", "enablePublicKeyPinningBypassForLocalTrustAnchors -> true");
                    return this.enablePublicKeyPinningBypassForLocalTrustAnchors(true);
                };
                netBuilder.addPublicKeyPins.implementation = function (hostName, pinsSha256, includeSubdomains, expirationDate) {
                    vlog("Cronet", "addPublicKeyPins(" + hostName + ") 忽略");
                    return this;
                };
            });

            // ---------- 11. Appcelerator Titanium ----------
            category("Appcelerator", CONFIG.hookAppcelerator, function () {
                var PinningTrustManager = Java.use('appcelerator.https.PinningTrustManager');
                PinningTrustManager.checkServerTrusted.implementation = function () {
                    vlog("Appcelerator", "checkServerTrusted 放行");
                };
            });

            U.ok("ssl_unpinning ready: " + active.length + " 类已生效 [" + active.join(", ") + "]");
        });
    }

    install();
})(this);

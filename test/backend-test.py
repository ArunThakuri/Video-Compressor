#!/usr/bin/env python3
"""
Unit checks for the download server's input handling.

These are the parts that decide whether the deployment is safe to leave on the
internet, so they are tested rather than eyeballed. No server is started and no
network is touched.

    py -3.12 -I test/backend-test.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "backend", "app.py")

spec = importlib.util.spec_from_file_location("mp4dl_app", APP)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

passed = 0
failed = 0


def check(label, cond, extra=""):
    global passed, failed
    if cond:
        print("  ok   " + label)
        passed += 1
    else:
        print("  FAIL " + label + ("  -> " + str(extra) if extra else ""))
        failed += 1


print("host allowlist")


def allowed(host):
    return app.host_allowed(host)


check("exact host", allowed("youtube.com"))
check("subdomain", allowed("m.youtube.com"))
check("other subdomain", allowed("vm.tiktok.com"))
check("short link host", allowed("youtu.be"))
# The suffix test is the one that is easy to get wrong: "evilyoutube.com"
# must not pass just because it ends with a real domain.
check("look-alike domain rejected", not allowed("evilyoutube.com"))
check("domain in the path rejected", not allowed("youtube.com.evil.test"))
check("bare localhost rejected", not allowed("localhost"))
check("private IP rejected", not allowed("192.168.1.10"))
check("IPv6 literal rejected", not allowed("[::1]"))
check("empty host rejected", not allowed(""))

print("\nURL validation")


def accepts(url):
    try:
        app.validate_url(url)
        return True
    except app.BadURL:
        return False


check("https youtube", accepts("https://www.youtube.com/watch?v=abc"))
check("http allowed too", accepts("http://youtu.be/abc"))
check("query string preserved", app.validate_url("https://youtu.be/abc?t=10") == "https://youtu.be/abc?t=10")
check("leading/trailing space stripped", app.validate_url("  https://youtu.be/abc  ") == "https://youtu.be/abc")
check("javascript: rejected", not accepts("javascript:alert(1)"))
check("file: rejected", not accepts("file:///etc/passwd"))
check("ftp: rejected", not accepts("ftp://youtube.com/x"))
check("credentials rejected", not accepts("https://user:pass@youtube.com/x"))
check("unknown site rejected", not accepts("https://example.com/x"))
check("empty rejected", not accepts(""))
check("over-long rejected", not accepts("https://youtu.be/" + "a" * 3000))

print("\nfile naming")

name = app.safe_name('Bad/Name: with*chars?"<>|', "video")
check("path separators stripped", "/" not in name and "\\" not in name, name)
check("reserved characters stripped", not any(c in name for c in ':?"<>|*'), name)
check("newlines stripped", "\n" not in app.safe_name("a\nb", "video"))
check("empty falls back", app.safe_name("   ", "video") == "video")
check("empty after cleaning falls back", app.safe_name("///", "video") == "video")
check("length capped", len(app.safe_name("x" * 500, "video")) <= 110)
check("unicode preserved",
      "नमस्ते" in app.safe_name("नमस्ते video", "video"),
      app.safe_name("नमस्ते video", "video"))

print("\nerror messages")

msg = app.clean_error(
    "\x1b[0;31mERROR:\x1b[0m [youtube] dQw4w9WgXcQ: Video unavailable\x1b[0m"
)
check("ANSI stripped", "\x1b" not in msg)
check("extractor prefix stripped", not msg.startswith("["), msg)
check("reason kept", "Video unavailable" in msg, msg)
check("empty stderr still explains", bool(app.clean_error("")))
check("long message capped", len(app.clean_error("x" * 5000)) <= 400)

print("\nformat ladder")

check("all four modes exist", set(app.FORMATS) == {"best", "720", "480", "audio"})
check("best is capped at 1080", "height<=1080" in app.FORMATS["best"])
check("audio has a fallback", "/" in app.FORMATS["audio"])

print("\ntrim / section downloads")


def t(raw):
    try:
        return app.parse_time(raw)
    except app.BadTime:
        return None


check("plain seconds", t("90") == 90.0)
check("decimal seconds", t("12.5") == 12.5)
check("whitespace tolerated", t(" 90 ") == 90.0)
check("zero is valid", t("0") == 0.0)
check("negative rejected", t("-3") is None)
check("non-numeric rejected", t("1:2:3:4 extra") is None)
check("nothing after a flag is injected", t("90 --exec rm") is None)
check("absurdly long rejected", t("99999") is None)

check("youtube watch URL trims", app.is_youtube("https://www.youtube.com/watch?v=abc"))
check("youtu.be trims", app.is_youtube("https://youtu.be/abc"))
check("music.youtube trims", app.is_youtube("https://music.youtube.com/watch?v=abc"))
check("tiktok does not trim", not app.is_youtube("https://www.tiktok.com/@x/video/1"))
check("look-alike does not trim", not app.is_youtube("https://evilyoutube.com/watch?v=abc"))

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)

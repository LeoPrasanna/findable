"""Pure-function tests for the extraction pipeline — the core of save reliability."""
from unittest.mock import patch

from app.services import extractor


class TestNormalizeUrl:
    def test_youtu_be_becomes_shorts(self):
        assert extractor.normalize_url("https://youtu.be/dQw4w9WgXcQ?si=abc") == \
            "https://www.youtube.com/shorts/dQw4w9WgXcQ"

    def test_strips_tracking_params(self):
        assert extractor.normalize_url("https://ex.com/p?utm_source=ig&keep=1") == \
            "https://ex.com/p?keep=1"

    def test_strips_youtube_si_keeps_real_params(self):
        assert extractor.normalize_url("https://www.youtube.com/shorts/AbC?si=x&t=5") == \
            "https://www.youtube.com/shorts/AbC?t=5"

    def test_trailing_slash_removed(self):
        assert extractor.normalize_url("https://ex.com/p/") == "https://ex.com/p"

    def test_fragment_removed(self):
        assert extractor.normalize_url("https://ex.com/p#section") == "https://ex.com/p"


class TestDetectPlatform:
    def test_each_platform(self):
        assert extractor.detect_platform("https://instagram.com/reel/x") == "instagram"
        assert extractor.detect_platform("https://youtu.be/x") == "youtube"
        assert extractor.detect_platform("https://www.youtube.com/shorts/x") == "youtube"
        assert extractor.detect_platform("https://www.tiktok.com/@a/video/1") == "tiktok"
        assert extractor.detect_platform("https://www.linkedin.com/posts/x") == "linkedin"
        # The LinkedIn APP only ever shares lnkd.in links — a share from LinkedIn
        # was rejected as unrecognised until 2026-09-09 because of this one host.
        assert extractor.detect_platform("https://lnkd.in/p/dpiMt3YS") == "linkedin"
        assert extractor.detect_platform("https://www.facebook.com/reel/1") == "facebook"
        assert extractor.detect_platform("https://fb.watch/x") == "facebook"
        assert extractor.detect_platform("https://example.com/x") == "unknown"

    def test_threads_both_domains(self):
        # Threads moved from threads.net to threads.com. The app shares .com
        # today; every link shared before the move is still a live .net URL, so
        # recognising only one host rejects half the real-world links.
        assert extractor.detect_platform("https://www.threads.com/@a/post/DAbc123") == "threads"
        assert extractor.detect_platform("https://www.threads.net/@a/post/DAbc123") == "threads"
        assert extractor.detect_platform("https://threads.com/@a/post/DAbc123?xmt=z") == "threads"

    def test_platform_name_anywhere_in_the_url_is_not_a_platform(self):
        """⚠️ SSRF REGRESSION. `detect_platform` is the ONLY synchronous check
        before /save and /share-save fetch a URL server-side, and it used to
        substring-match the whole string: anything CONTAINING a platform name
        passed, wherever it appeared. Each of these was accepted, fetched from
        the server's own network, and its title and description handed back on a
        card. Owner-reported, fixed 2026-09-23."""
        ssrf = [
            # Cloud metadata, platform name parked in the query string.
            "http://169.254.169.254/latest/meta-data?q=threads.com",
            # A private address, platform name in the path.
            "http://10.0.0.5:8080/instagram.com",
            "https://evil.example/threads.net/x",
            # Subdomain trick — the dotted boundary is what stops this.
            "https://instagram.com.evil.example/x",
            # userinfo: the host here is evil.example, not threads.com. Parsing
            # is the only thing that tells them apart.
            "https://threads.com@evil.example/",
            "https://user:pw@youtube.com.evil.example/",
            # Not http(s) — no business reaching a fetcher at all.
            "file:///etc/passwd?x=youtube.com",
            "gopher://127.0.0.1:6379/_INFO?youtu.be",
            # Bare loopback and IPv6 loopback.
            "http://127.0.0.1:8000/facebook.com",
            "http://[::1]/tiktok.com",
        ]
        for url in ssrf:
            assert extractor.detect_platform(url) == "unknown", url

    def test_subdomains_and_trailing_dot(self):
        # The fix must not cost real links: platform subdomains are normal, and
        # a trailing dot is a legal FQDN that resolves identically — so it must
        # not be a way to sit just outside the match either.
        assert extractor.detect_platform("https://m.youtube.com/shorts/x") == "youtube"
        assert extractor.detect_platform("https://vm.tiktok.com/ZM1/") == "tiktok"
        assert extractor.detect_platform("https://web.facebook.com/reel/1") == "facebook"
        assert extractor.detect_platform("http://threads.com./@a/post/1") == "threads"
        assert extractor.detect_platform("https://WWW.Instagram.COM/reel/x") == "instagram"

    def test_malformed_urls_do_not_raise(self):
        # A save request carries a user-supplied string; this must fail closed
        # rather than 500.
        for url in ["", "not a url", "http://", "http://[::1", "https://:::/x"]:
            assert extractor.detect_platform(url) == "unknown", url

    def test_threads_does_not_shadow_instagram(self):
        # Both are Meta and both can carry an `igshid`; the Instagram branch is
        # checked first and must keep winning for instagram.com URLs.
        assert extractor.detect_platform("https://www.instagram.com/reel/x?igshid=1") == "instagram"


class TestOg:
    def test_reads_og_property(self):
        html = '<meta property="og:title" content="Hello World">'
        assert extractor._og(html, "title") == "Hello World"

    def test_unescapes_entities(self):
        html = '<meta property="og:description" content="Tom &amp; Jerry &lt;3">'
        assert extractor._og(html, "description") == "Tom & Jerry <3"

    def test_multiline_content_is_preserved(self):
        # Instagram recipe captions span newlines inside one <meta> tag.
        html = '<meta property="og:description" content="Step 1\nStep 2">'
        assert extractor._og(html, "description") == "Step 1\nStep 2"

    def test_missing_property_returns_empty(self):
        assert extractor._og('<meta property="og:title" content="x">', "image") == ""

    def test_sub_property_does_not_masquerade(self):
        # Regression: 'og:image:alt' (caption text) must NOT be returned for
        # 'og:image'. Facebook emits the alt tag, and the old substring match
        # returned it — so the thumbnail became the title string, not the image URL.
        html = (
            '<meta property="og:image:alt" content="A caption describing it">'
            '<meta property="og:image" content="https://cdn.example/pic.jpg">'
        )
        assert extractor._og(html, "image") == "https://cdn.example/pic.jpg"

    def test_matches_when_content_precedes_property(self):
        # Attribute order within the tag must not matter.
        html = '<meta content="https://cdn.example/x.jpg" property="og:image">'
        assert extractor._og(html, "image") == "https://cdn.example/x.jpg"

    def test_does_not_hang_on_huge_minified_page(self):
        # Regression guard: the old whole-document DOTALL pattern backtracked for
        # tens of seconds on ~600 KB of inline script with no clean <head>.
        import time
        html = '<script>' + ("var x=1;" * 80_000) + '</script>' \
               '<meta property="og:title" content="Found">'
        start = time.monotonic()
        assert extractor._og(html, "title") == "Found"
        assert time.monotonic() - start < 1.0


class TestExtractJsonld:
    def test_pulls_article_body(self):
        html = (
            '<script type="application/ld+json">'
            '{"articleBody": "Full LinkedIn post text", "headline": "Title"}'
            '</script>'
        )
        result = extractor._extract_jsonld(html)
        assert result["articleBody"] == "Full LinkedIn post text"
        assert result["headline"] == "Title"

    def test_handles_list_of_blocks(self):
        html = (
            '<script type="application/ld+json">'
            '[{"@type": "WebPage"}, {"text": "Body via text field"}]'
            '</script>'
        )
        assert extractor._extract_jsonld(html)["articleBody"] == "Body via text field"

    def test_invalid_json_is_skipped(self):
        assert extractor._extract_jsonld('<script type="application/ld+json">{bad}</script>') == {}


class TestParseVtt:
    def test_dedupes_strips_tags_and_metadata(self):
        vtt = (
            "WEBVTT\n"
            "Kind: captions\n"
            "Language: en\n"
            "\n"
            "00:00:00.000 --> 00:00:02.000\n"
            "Hello world\n"
            "\n"
            "00:00:02.000 --> 00:00:04.000\n"
            "Hello world\n"
            "\n"
            "00:00:04.000 --> 00:00:06.000\n"
            "<c>Second</c> line\n"
        )
        assert extractor._parse_vtt(vtt) == "Hello world Second line"

    def test_empty(self):
        assert extractor._parse_vtt("WEBVTT\n") == ""


class TestFetchPageObservability:
    """A host we cannot reach used to return None in complete silence — only
    403/429 status codes were logged, never transport errors. The caller then
    reported it as 'no text on the page', which is the wrong cause."""

    def test_transport_failures_are_reported_once(self, monkeypatch, caplog):
        def always_fails(url, headers=None, **kw):
            raise OSError("name resolution failed")
        monkeypatch.setattr(extractor._http, "get", always_fails)
        monkeypatch.setattr(extractor.time, "sleep", lambda _s: None)

        with caplog.at_level("ERROR"):
            assert extractor._fetch_page("https://unreachable.example/p") is None

        hits = [r for r in caplog.records if "identities failed to reach" in r.message]
        assert len(hits) == 1, "expected exactly one summary line, not one per identity"
        assert "OSError" in hits[0].message
        assert "unreachable.example" in hits[0].message


# ── Facebook: a title-only yt-dlp result must not short-circuit the fallbacks ──
#
# Both regressions here shipped together on one card:
#   "5.1M views · 189K reactions | This Quote Changes Everything… | Chris Williamson"
#   "Facebook requires login — we couldn't read this automatically"
# The engagement prefix was already stripped — on a code path Facebook never
# took — and the caption fallback was skipped because a title alone satisfied
# the "did yt-dlp give us anything?" guard.

def test_clean_title_strips_engagement_prefix():
    assert extractor.clean_title_text(
        "5.1M views · 189K reactions | This Quote Changes Everything | Chris Williamson"
    ) == "This Quote Changes Everything | Chris Williamson"
    assert extractor.clean_title_text("205K views | Real title") == "Real title"
    assert extractor.clean_title_text("Sandeep Jain posted | LinkedIn") == "Sandeep Jain posted"
    # A title that merely CONTAINS a number must survive untouched.
    assert extractor.clean_title_text("5 things | I learned") == "5 things | I learned"


def test_textless_ydl_result_falls_through_to_page_fallback():
    """yt-dlp gives Facebook a title and a thumbnail and no words. The caption
    lives on the og: surface, so the extractor has to keep going — while still
    keeping the metadata yt-dlp did manage."""
    shell = {"title": "5.1M views · 189K reactions | Real title", "thumbnail": "https://cdn/t.jpg", "uploader": "Chris"}
    with patch.object(extractor, "_run_ydl", return_value=shell), \
         patch.object(extractor, "_pick_thumbnail", return_value="https://cdn/t.jpg"), \
         patch.object(extractor, "_extract_from_page", return_value={"description": "the actual caption body"}), \
         patch.object(extractor, "facebook_oembed", return_value={}):
        out = extractor.extract_info("https://www.facebook.com/reel/123456")

    assert out["best_text"] == "the actual caption body"   # fallback ran
    assert out["title"] == "Real title"                    # prefix stripped
    assert out["thumbnail_url"] == "https://cdn/t.jpg"     # ydl metadata kept
    assert out["login_required"] is False

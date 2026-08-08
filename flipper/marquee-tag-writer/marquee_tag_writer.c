/*
 * Marquee Tag Writer — Flipper Zero app (Route B, issue #68).
 *
 * Pick an album from a Curator-exported list and write its `curator:<kind>:<id>` NDEF URI to a blank
 * NTAG213; or read a tag back to see which album is on it. See docs/specs/flipper-tag-writer.md.
 *
 * Validated against official firmware 1.4.3 (ufbt --channel=release, API 87.1).
 *
 * Three things about the NFC stack were established on hardware and drive the shape of this file
 * (spec §6 records them):
 *
 *   1. Every page operation for one tag must happen inside a SINGLE poller session. The
 *      `mf_ultralight_poller_sync_*` helpers each run a self-contained session (field on -> activate
 *      -> one op -> field off) and leave the tag HALTed, so chaining them fails on the second call
 *      with MfUltralightErrorTimeout. We start one poller and do every page op in its callback.
 *   2. The callback must return NfcCommandContinue while no card is present, or the poller stops
 *      instantly instead of waiting for the user to present a tag.
 *   3. NTAG READ returns 4 pages (16 bytes) per command, while WRITE takes one page (4 bytes).
 *
 * The NFC job runs on its own thread so the "hold a tag" screen actually renders; the worker reports
 * back through a ViewDispatcher custom event.
 *
 * Build: ufbt      Run: ufbt launch      Logs: ufbt cli
 */
#include <furi.h>
#include <gui/gui.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/popup.h>
#include <storage/storage.h>

#include <nfc/nfc.h>
#include <nfc/nfc_poller.h>
#include <nfc/protocols/mf_ultralight/mf_ultralight.h>
#include <nfc/protocols/mf_ultralight/mf_ultralight_poller.h>

#define TAG "MarqueeTagWriter"

#define CURATOR_ID_LEN 8
#define MAX_ALBUMS 64
#define LABEL_LEN 48

/* NTAG213 layout. User memory is pages 4-39; page 3 is the Capability Container. */
#define NTAG_PAGE_SIZE 4
#define NTAG_CC_PAGE 3
#define NTAG_USER_PAGE_START 4
#define NTAG_USER_PAGE_END 39

/* The TLV for a 22-char album URI is 30 bytes; card and demo URIs are 21 chars → 29. 48 covers all
 * three plus slack. The write path derives its page count from the TLV length, so no special case. */
#define TLV_CAP 48
/* Read enough user memory to hold any TLV we write: 3 READs x 16 bytes. */
#define READ_CAP 48

#define PENDING_CSV APP_DATA_PATH("pending.csv")
/* Heap-allocated — see load_pending_albums(). MAX_ALBUMS rows of "id,name,artist" fit comfortably. */
#define CSV_BUF_SIZE 4096

/* How long the user gets to present a tag before we give up. */
#define NFC_TIMEOUT_MS 15000
#define NFC_POLL_SLICE_MS 100

/* Capability Container for a 144-byte NTAG213. Written only if the tag does not already have one —
 * the CC is effectively one-way, so we never clear or rewrite bits that are already set. */
static const uint8_t kNtag213Cc[NTAG_PAGE_SIZE] = {0xE1, 0x10, 0x12, 0x00};

/* ---------------------------------------------------------------------------------------------
 * NDEF — the portable, tested-by-contract core. Mirrors packages/curator/src/tags/flipper-nfc.ts
 * (ndefUriTlv) exactly; do not diverge. Produces:  03 <len> D1 01 <plen> 55 00 <ascii> FE
 * --------------------------------------------------------------------------------------------- */

/** Build the NDEF-message TLV for `uri`. Returns the TLV length, or 0 if it wouldn't fit `out_cap`. */
static size_t marquee_build_ndef_tlv(const char* uri, uint8_t* out, size_t out_cap) {
    size_t uri_len = strlen(uri);
    if(uri_len == 0 || uri_len > 0xFE) return 0;

    const uint8_t payload_len = (uint8_t)(1 + uri_len); // 0x00 prefix + ascii
    const uint8_t record_len = (uint8_t)(4 + payload_len); // hdr,typelen,plen,type + payload
    const size_t tlv_len = 2 + (size_t)record_len + 1; // 03,len + record + FE
    if(tlv_len > out_cap) return 0;

    size_t i = 0;
    out[i++] = 0x03; // NDEF-message TLV
    out[i++] = record_len; // TLV length
    out[i++] = 0xD1; // record header: MB|ME|SR, TNF=well-known
    out[i++] = 0x01; // type length
    out[i++] = payload_len; // payload length (short record)
    out[i++] = 0x55; // type 'U' (URI)
    out[i++] = 0x00; // URI prefix code (none — custom scheme)
    memcpy(&out[i], uri, uri_len);
    i += uri_len;
    out[i++] = 0xFE; // terminator TLV
    return i;
}

/**
 * The physical object a tag is stuck to (ADR 0034, ADR 0058). A **sleeve** carries
 * `curator:album:<id>` — you drop the needle on the vinyl; a **card** carries `curator:card:<id>`,
 * which Amp streams over Sonos; a **demo** tag carries `curator:demo:<id>`, which Amp streams as the
 * one track chosen for that album in Curator. All three name the same album; only the kind differs.
 * Mirrors `tagUri()` in Route A.
 */
typedef enum {
    TagKindSleeve,
    TagKindCard,
    TagKindDemo,
} TagKind;

/** The kind's word on the wire — the middle segment of `curator:<kind>:<id>`. */
static const char* tag_kind_word(TagKind kind) {
    if(kind == TagKindCard) return "card";
    if(kind == TagKindDemo) return "demo";
    return "album";
}

/** Compose the tag URI for a curator id and object kind. */
static void marquee_tag_uri(TagKind kind, const char* curator_id, char* out, size_t out_cap) {
    snprintf(out, out_cap, "curator:%s:%s", tag_kind_word(kind), curator_id);
}

/** Short form used on the hold/confirm screens and the album-list header. */
static const char* tag_kind_short(TagKind kind) {
    if(kind == TagKindCard) return "Card";
    if(kind == TagKindDemo) return "Demo";
    return "Sleeve";
}

/**
 * Parse a `curator:...` URI out of NTAG user bytes. Accepts the same layout we write: an NDEF-message
 * TLV holding one well-known URI record with prefix code 0x00. Returns true and fills `uri` on success.
 * Deliberately strict — a tag we cannot parse should say so rather than show a half-decoded string.
 */
static bool marquee_parse_ndef_uri(const uint8_t* data, size_t len, char* uri, size_t uri_cap) {
    size_t i = 0;
    /* Skip any NULL TLVs (0x00) that may pad the front. */
    while(i < len && data[i] == 0x00)
        i++;
    if(i + 1 >= len) return false;
    if(data[i] != 0x03) return false; // not an NDEF-message TLV
    const uint8_t record_len = data[i + 1];
    i += 2;
    if(record_len < 5 || i + record_len > len) return false;

    if(data[i] != 0xD1) return false; // MB|ME|SR, TNF=well-known
    if(data[i + 1] != 0x01) return false; // type length
    const uint8_t payload_len = data[i + 2];
    if(data[i + 3] != 0x55) return false; // type 'U'
    if(payload_len < 1) return false;
    if(data[i + 4] != 0x00) return false; // URI prefix code: none
    if((size_t)(4 + payload_len) != (size_t)record_len) return false;

    const size_t ascii_len = payload_len - 1;
    if(ascii_len + 1 > uri_cap) return false;
    memcpy(uri, &data[i + 5], ascii_len);
    uri[ascii_len] = '\0';
    return true;
}

/* ---------------------------------------------------------------------------------------------
 * App state
 * --------------------------------------------------------------------------------------------- */
typedef struct {
    char curator_id[CURATOR_ID_LEN + 1];
    char label[LABEL_LEN]; // "name - artist"
} AlbumItem;

/*
 * Navigation: Main -> (Write) -> Kind -> Albums -> Popup, or Main -> (Read) -> Popup. Each level is
 * its own Submenu view so Back pops one step naturally. Mode choices (read/write, and which of the
 * three tag kinds) are their own screens rather than rows mixed into the album list — the list is
 * data, not controls.
 */
typedef enum {
    ViewMenuMain,
    ViewMenuKind,
    ViewMenuAlbums,
    ViewPopup,
} AppView;

typedef enum {
    JobWrite,
    JobRead,
} JobKind;

typedef enum {
    JobResultNone,
    JobResultOk,
    JobResultNoTag,
    JobResultWriteFailed,
    JobResultVerifyMismatch,
    JobResultUnreadable,
    JobResultCardUnusable,
} JobResult;

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    Submenu* menu_main;
    Submenu* menu_kind;
    Submenu* menu_albums;
    Popup* popup;

    AlbumItem albums[MAX_ALBUMS];
    size_t album_count;
    bool from_csv; // false => the built-in demo entry, which we label as such
    TagKind tag_kind; // which object kind the next write composes

    /* Current job, shared between the GUI thread and the worker. */
    FuriThread* worker;
    JobKind job_kind;
    size_t job_album; // index into albums, for JobWrite
    uint8_t tlv[TLV_CAP];
    size_t tlv_len;
    FuriEventFlag* job_done;
    JobResult result;
    MfUltralightError err;
    char read_uri[64];

    char albums_header[32];
    char result_header[40];
    /* Big enough for the longest composition below: a 63-char URI plus a 39-char label and a newline. */
    char result_text[128];
} App;

#define JOB_DONE_FLAG (1U << 0)

/* Main menu entries. */
#define MENU_MAIN_WRITE 0u
#define MENU_MAIN_READ 1u
/* Kind menu entries — the values double as the TagKind they select, so the enum's order and these
 * must stay in step. Asserted below rather than trusted. */
#define MENU_KIND_SLEEVE 0u
#define MENU_KIND_CARD 1u
#define MENU_KIND_DEMO 2u

typedef enum {
    CustomEventJobFinished = 1,
} CustomEvent;

static const char* mfu_error_name(MfUltralightError err) {
    switch(err) {
    case MfUltralightErrorNone:
        return "none";
    case MfUltralightErrorNotPresent:
        return "no tag";
    case MfUltralightErrorProtocol:
        return "protocol";
    case MfUltralightErrorAuth:
        return "locked";
    case MfUltralightErrorTimeout:
        return "timeout";
    default:
        return "unknown";
    }
}

/* ---------------------------------------------------------------------------------------------
 * The pending list, exported by Curator to the SD card (spec §3).
 *   /ext/apps_data/marquee_tag_writer/pending.csv   ->   curatorId,name,artist
 * Split on the first two commas only, so a comma inside an artist name survives; a comma inside a
 * *name* would shift the split, which is why Curator's export keeps the id first.
 * --------------------------------------------------------------------------------------------- */

/** Copy `src` into `dst` as printable ASCII — the Flipper font has no glyphs for UTF-8 sequences. */
static void copy_ascii(char* dst, size_t dst_cap, const char* src, size_t src_len) {
    size_t o = 0;
    for(size_t i = 0; i < src_len && o + 1 < dst_cap; i++) {
        unsigned char c = (unsigned char)src[i];
        if(c == '\r' || c == '\n') break;
        dst[o++] = (c >= 0x20 && c < 0x7F) ? (char)c : '?';
    }
    dst[o] = '\0';
}

static bool parse_csv_line(const char* line, size_t len, AlbumItem* out) {
    const char* c1 = memchr(line, ',', len);
    if(!c1) return false;
    size_t id_len = (size_t)(c1 - line);
    if(id_len != CURATOR_ID_LEN) return false;

    const char* rest = c1 + 1;
    size_t rest_len = len - id_len - 1;
    const char* c2 = memchr(rest, ',', rest_len);

    copy_ascii(out->curator_id, sizeof(out->curator_id), line, id_len);

    /* Sized so the worst case ("name - artist") still fits LABEL_LEN — the compiler checks this. */
    char name[26];
    char artist[20];
    if(c2) {
        copy_ascii(name, sizeof(name), rest, (size_t)(c2 - rest));
        copy_ascii(artist, sizeof(artist), c2 + 1, rest_len - (size_t)(c2 - rest) - 1);
        snprintf(out->label, sizeof(out->label), "%s - %s", name, artist);
    } else {
        copy_ascii(name, sizeof(name), rest, rest_len);
        snprintf(out->label, sizeof(out->label), "%s", name);
    }
    return out->curator_id[0] != '\0';
}

static void load_pending_albums(App* app) {
    app->album_count = 0;
    app->from_csv = false;

    Storage* storage = furi_record_open(RECORD_STORAGE);
    File* file = storage_file_alloc(storage);

    /* The list is short (tens of albums), so read it whole rather than streaming — but on the HEAP.
     * A buffer this size does not fit the app's stack, and overflowing it kills the app on launch. */
    char* buf = malloc(CSV_BUF_SIZE);
    if(buf && storage_file_open(file, PENDING_CSV, FSAM_READ, FSOM_OPEN_EXISTING)) {
        size_t read = storage_file_read(file, buf, CSV_BUF_SIZE - 1);
        buf[read] = '\0';

        size_t start = 0;
        for(size_t i = 0; i <= read && app->album_count < MAX_ALBUMS; i++) {
            if(i != read && buf[i] != '\n') continue;
            size_t line_len = i - start;
            while(line_len > 0 && buf[start + line_len - 1] == '\r')
                line_len--;
            if(line_len > 0 && strncmp(&buf[start], "curatorId", 9) != 0) {
                AlbumItem item;
                memset(&item, 0, sizeof(item));
                if(parse_csv_line(&buf[start], line_len, &item)) {
                    app->albums[app->album_count++] = item;
                }
            }
            start = i + 1;
        }
        app->from_csv = true;
        FURI_LOG_I(TAG, "loaded %zu albums from %s", app->album_count, PENDING_CSV);
    } else {
        FURI_LOG_W(TAG, "no %s — falling back to the demo entry", PENDING_CSV);
    }

    if(buf) free(buf);
    storage_file_close(file);
    storage_file_free(file);
    furi_record_close(RECORD_STORAGE);

    /* No list on the SD card: offer one clearly-labelled demo entry so the write path is still
     * exercisable during bring-up. Labelled DEMO so it can never be mistaken for a real album. */
    if(app->album_count == 0) {
        snprintf(app->albums[0].curator_id, sizeof(app->albums[0].curator_id), "%s", "2k7bxq9m");
        snprintf(app->albums[0].label, sizeof(app->albums[0].label), "DEMO: Purple Rain");
        app->album_count = 1;
    }
}

/* ---------------------------------------------------------------------------------------------
 * NFC — one poller session, every page operation inside the callback.
 * --------------------------------------------------------------------------------------------- */

/** Write `tlv` into user pages, plus the CC if the tag hasn't got one, then read back and compare. */
static JobResult nfc_do_write(App* app, MfUltralightPoller* poller, MfUltralightError* err_out) {
    const size_t pages_needed = (app->tlv_len + NTAG_PAGE_SIZE - 1) / NTAG_PAGE_SIZE;
    if(NTAG_USER_PAGE_START + pages_needed - 1 > NTAG_USER_PAGE_END) {
        FURI_LOG_E(TAG, "TLV of %zu bytes exceeds user memory", app->tlv_len);
        return JobResultWriteFailed;
    }

    /* CC: write it only when absent. A factory NTAG213 usually ships with it already set; clearing or
     * rewriting CC bits is one-way and can brick the tag for NDEF readers. */
    MfUltralightPageReadCommandData cc_read;
    memset(&cc_read, 0, sizeof(cc_read));
    MfUltralightError err = mf_ultralight_poller_read_page(poller, NTAG_CC_PAGE, &cc_read);
    if(err != MfUltralightErrorNone) {
        *err_out = err;
        return JobResultCardUnusable;
    }
    if(cc_read.page[0].data[0] != 0xE1) {
        MfUltralightPage cc;
        memcpy(cc.data, kNtag213Cc, NTAG_PAGE_SIZE);
        FURI_LOG_I(TAG, "CC absent — writing E1 10 12 00");
        err = mf_ultralight_poller_write_page(poller, NTAG_CC_PAGE, &cc);
        if(err != MfUltralightErrorNone) {
            *err_out = err;
            return JobResultWriteFailed;
        }
    }

    /* User pages: the TLV, zero-padded to a page boundary. */
    for(size_t p = 0; p < pages_needed; p++) {
        MfUltralightPage page;
        memset(page.data, 0, NTAG_PAGE_SIZE);
        size_t off = p * NTAG_PAGE_SIZE;
        size_t n = app->tlv_len - off;
        if(n > NTAG_PAGE_SIZE) n = NTAG_PAGE_SIZE;
        memcpy(page.data, &app->tlv[off], n);

        err = mf_ultralight_poller_write_page(
            poller, (uint8_t)(NTAG_USER_PAGE_START + p), &page);
        if(err != MfUltralightErrorNone) {
            FURI_LOG_E(TAG, "write page %zu failed: %s", NTAG_USER_PAGE_START + p, mfu_error_name(err));
            *err_out = err;
            return JobResultWriteFailed;
        }
    }

    /* Verify: read the pages back and compare the TLV bytes we care about. READ returns 4 pages. */
    uint8_t back[READ_CAP];
    memset(back, 0, sizeof(back));
    size_t got = 0;
    while(got < app->tlv_len && got < sizeof(back)) {
        MfUltralightPageReadCommandData rd;
        memset(&rd, 0, sizeof(rd));
        uint8_t page = (uint8_t)(NTAG_USER_PAGE_START + got / NTAG_PAGE_SIZE);
        err = mf_ultralight_poller_read_page(poller, page, &rd);
        if(err != MfUltralightErrorNone) {
            *err_out = err;
            return JobResultVerifyMismatch;
        }
        for(size_t i = 0; i < 4 && got < sizeof(back); i++) {
            memcpy(&back[got], rd.page[i].data, NTAG_PAGE_SIZE);
            got += NTAG_PAGE_SIZE;
        }
    }

    if(memcmp(back, app->tlv, app->tlv_len) != 0) {
        FURI_LOG_E(TAG, "verify mismatch");
        return JobResultVerifyMismatch;
    }
    *err_out = MfUltralightErrorNone;
    return JobResultOk;
}

/** Read user memory and decode the curator URI on it. */
static JobResult nfc_do_read(App* app, MfUltralightPoller* poller, MfUltralightError* err_out) {
    uint8_t data[READ_CAP];
    memset(data, 0, sizeof(data));
    size_t got = 0;
    while(got + 16 <= sizeof(data)) {
        MfUltralightPageReadCommandData rd;
        memset(&rd, 0, sizeof(rd));
        uint8_t page = (uint8_t)(NTAG_USER_PAGE_START + got / NTAG_PAGE_SIZE);
        MfUltralightError err = mf_ultralight_poller_read_page(poller, page, &rd);
        if(err != MfUltralightErrorNone) {
            *err_out = err;
            return got == 0 ? JobResultCardUnusable : JobResultUnreadable;
        }
        for(size_t i = 0; i < 4; i++) {
            memcpy(&data[got], rd.page[i].data, NTAG_PAGE_SIZE);
            got += NTAG_PAGE_SIZE;
        }
    }

    *err_out = MfUltralightErrorNone;
    if(!marquee_parse_ndef_uri(data, got, app->read_uri, sizeof(app->read_uri))) {
        return JobResultUnreadable;
    }
    return JobResultOk;
}

static NfcCommand nfc_poller_callback(NfcGenericEvent event, void* context) {
    App* app = context;
    furi_assert(event.protocol == NfcProtocolMfUltralight);

    MfUltralightPoller* poller = event.instance;
    MfUltralightPollerEvent* mfu_event = event.event_data;

    /* Keep polling until a card is actually activated — the poller emits other events (e.g. a failed
     * read) while the field is empty, and stopping on those makes the app a one-shot that only works
     * if the tag is already in place. */
    if(mfu_event->type != MfUltralightPollerEventTypeRequestMode) {
        if(mfu_event->type == MfUltralightPollerEventTypeCardLocked) {
            app->result = JobResultCardUnusable;
            app->err = MfUltralightErrorAuth;
            furi_event_flag_set(app->job_done, JOB_DONE_FLAG);
            return NfcCommandStop;
        }
        return NfcCommandContinue;
    }

    MfUltralightError err = MfUltralightErrorNone;
    app->result = (app->job_kind == JobWrite) ? nfc_do_write(app, poller, &err) :
                                                nfc_do_read(app, poller, &err);
    app->err = err;
    furi_event_flag_set(app->job_done, JOB_DONE_FLAG);
    return NfcCommandStop;
}

static int32_t nfc_worker(void* context) {
    App* app = context;

    app->result = JobResultNone;
    app->err = MfUltralightErrorNone;
    furi_event_flag_clear(app->job_done, JOB_DONE_FLAG);

    Nfc* nfc = nfc_alloc();
    NfcPoller* poller = nfc_poller_alloc(nfc, NfcProtocolMfUltralight);
    nfc_poller_start(poller, nfc_poller_callback, app);

    uint32_t waited = 0;
    while(waited < NFC_TIMEOUT_MS) {
        uint32_t flags = furi_event_flag_wait(
            app->job_done, JOB_DONE_FLAG, FuriFlagWaitAny, NFC_POLL_SLICE_MS);
        if(flags & JOB_DONE_FLAG) break;
        waited += NFC_POLL_SLICE_MS;
    }

    nfc_poller_stop(poller);
    nfc_poller_free(poller);
    nfc_free(nfc);

    if(app->result == JobResultNone) app->result = JobResultNoTag;

    view_dispatcher_send_custom_event(app->view_dispatcher, CustomEventJobFinished);
    return 0;
}

/* Defined with the rest of the navigation below; start_job needs them to route Back. */
static uint32_t back_to_main(void* context);
static uint32_t back_to_albums(void* context);

static void start_job(App* app, JobKind kind) {
    app->job_kind = kind;
    popup_reset(app->popup);
    popup_set_header(app->popup, "Hold a tag", 64, 8, AlignCenter, AlignTop);
    if(kind == JobWrite) {
        /* Name the kind here too — the menu toggle alone would make it easy to write the wrong one. */
        snprintf(
            app->result_text,
            sizeof(app->result_text),
            "%s tag: %s\nBlank NTAG213 flat on back",
            tag_kind_short(app->tag_kind),
            app->albums[app->job_album].label);
        popup_set_text(app->popup, app->result_text, 64, 26, AlignCenter, AlignTop);
    } else {
        popup_set_text(app->popup, "Flat on the back\nto read it", 64, 26, AlignCenter, AlignTop);
    }
    /* Back from a finished job returns to whichever list started it. */
    view_set_previous_callback(
        popup_get_view(app->popup), kind == JobWrite ? back_to_albums : back_to_main);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewPopup);

    app->worker = furi_thread_alloc_ex("MarqueeNfc", 2048, nfc_worker, app);
    furi_thread_start(app->worker);
}

/* ---------------------------------------------------------------------------------------------
 * GUI
 * --------------------------------------------------------------------------------------------- */

/** Find the album whose id appears in `uri`, or SIZE_MAX. Lets a read show a name, not just an id. */
static size_t album_for_uri(App* app, const char* uri) {
    for(size_t i = 0; i < app->album_count; i++) {
        const char* id = app->albums[i].curator_id;
        if(id[0] && strstr(uri, id) != NULL) return i;
    }
    return (size_t)-1;
}

static void show_result(App* app) {
    const char* header = "";
    app->result_text[0] = '\0';

    if(app->job_kind == JobWrite) {
        switch(app->result) {
        case JobResultOk:
            header = app->tag_kind == TagKindCard ? "Card tag written" : "Sleeve tag written";
            snprintf(
                app->result_text,
                sizeof(app->result_text),
                "%s\nVerified. Read it back\nto check",
                app->albums[app->job_album].label);
            break;
        case JobResultNoTag:
            header = "No tag seen";
            snprintf(
                app->result_text, sizeof(app->result_text), "Lift it away, then\nhold it flat again");
            break;
        case JobResultWriteFailed:
            header = "Write failed";
            snprintf(app->result_text, sizeof(app->result_text), "%s", mfu_error_name(app->err));
            break;
        case JobResultVerifyMismatch:
            header = "Wrote, verify failed";
            snprintf(
                app->result_text, sizeof(app->result_text), "Tag may be faulty\nor moved mid-write");
            break;
        case JobResultCardUnusable:
            header = "Tag unusable";
            snprintf(
                app->result_text, sizeof(app->result_text), "Locked or not an\nNTAG/Ultralight tag");
            break;
        default:
            header = "No result";
            break;
        }
    } else {
        switch(app->result) {
        case JobResultOk: {
            size_t idx = album_for_uri(app, app->read_uri);
            header = "Tag reads";
            if(idx != (size_t)-1) {
                snprintf(
                    app->result_text,
                    sizeof(app->result_text),
                    "%s\n%s",
                    app->read_uri,
                    app->albums[idx].label);
            } else {
                snprintf(
                    app->result_text,
                    sizeof(app->result_text),
                    "%s\n(not in the list)",
                    app->read_uri);
            }
            break;
        }
        case JobResultNoTag:
            header = "No tag seen";
            snprintf(
                app->result_text, sizeof(app->result_text), "Lift it away, then\nhold it flat again");
            break;
        case JobResultUnreadable:
            header = "No Marquee tag";
            snprintf(
                app->result_text, sizeof(app->result_text), "Read it, but found no\ncurator: URI");
            break;
        case JobResultCardUnusable:
            header = "Tag unusable";
            snprintf(
                app->result_text, sizeof(app->result_text), "Locked or not an\nNTAG/Ultralight tag");
            break;
        default:
            header = "No result";
            break;
        }
    }

    snprintf(app->result_header, sizeof(app->result_header), "%s", header);
    popup_reset(app->popup);
    popup_set_header(app->popup, app->result_header, 64, 8, AlignCenter, AlignTop);
    popup_set_text(app->popup, app->result_text, 64, 26, AlignCenter, AlignTop);
}

static bool on_custom_event(void* context, uint32_t event) {
    App* app = context;
    if(event != CustomEventJobFinished) return false;

    if(app->worker) {
        furi_thread_join(app->worker);
        furi_thread_free(app->worker);
        app->worker = NULL;
    }
    show_result(app);
    return true;
}

static void on_main_selected(void* context, uint32_t index) {
    App* app = context;
    if(index == MENU_MAIN_WRITE) {
        view_dispatcher_switch_to_view(app->view_dispatcher, ViewMenuKind);
    } else if(index == MENU_MAIN_READ) {
        start_job(app, JobRead);
    }
}

static void on_kind_selected(void* context, uint32_t index) {
    App* app = context;
    /* The menu values ARE the TagKind values (see the MENU_KIND_* defines); anything unexpected
     * falls back to the sleeve rather than composing a URI for a kind that doesn't exist. */
    app->tag_kind = (index == MENU_KIND_CARD)  ? TagKindCard :
                    (index == MENU_KIND_DEMO)  ? TagKindDemo :
                                                 TagKindSleeve;

    /* Carry the choice into the album list's header, so the kind is still on screen at the moment the
     * album — the irreversible part — is picked. */
    snprintf(
        app->albums_header, sizeof(app->albums_header), "%s tag - pick album", tag_kind_short(app->tag_kind));
    submenu_set_header(app->menu_albums, app->albums_header);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewMenuAlbums);
}

static void on_album_selected(void* context, uint32_t index) {
    App* app = context;
    if(index >= app->album_count) return;

    app->job_album = index;
    char uri[64];
    marquee_tag_uri(app->tag_kind, app->albums[index].curator_id, uri, sizeof(uri));
    app->tlv_len = marquee_build_ndef_tlv(uri, app->tlv, sizeof(app->tlv));
    if(app->tlv_len == 0) {
        FURI_LOG_E(TAG, "could not build TLV for %s", uri);
        return;
    }
    FURI_LOG_I(TAG, "built %zu-byte TLV for %s", app->tlv_len, uri);
    start_job(app, JobWrite);
}

static uint32_t back_to_main(void* context) {
    UNUSED(context);
    return ViewMenuMain;
}

static uint32_t back_to_kind(void* context) {
    UNUSED(context);
    return ViewMenuKind;
}

static uint32_t back_to_albums(void* context) {
    UNUSED(context);
    return ViewMenuAlbums;
}

static uint32_t exit_app(void* context) {
    UNUSED(context);
    return VIEW_NONE;
}

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));

    app->gui = furi_record_open(RECORD_GUI);
    app->view_dispatcher = view_dispatcher_alloc();
    app->menu_main = submenu_alloc();
    app->menu_kind = submenu_alloc();
    app->menu_albums = submenu_alloc();
    app->popup = popup_alloc();
    app->job_done = furi_event_flag_alloc();

    load_pending_albums(app);

    submenu_set_header(app->menu_main, "Marquee Tag Writer");
    submenu_add_item(app->menu_main, "Write a tag", MENU_MAIN_WRITE, on_main_selected, app);
    submenu_add_item(app->menu_main, "Read a tag", MENU_MAIN_READ, on_main_selected, app);

    submenu_set_header(app->menu_kind, "Which kind of tag?");
    submenu_add_item(app->menu_kind, "Sleeve (album)", MENU_KIND_SLEEVE, on_kind_selected, app);
    submenu_add_item(app->menu_kind, "Card (Sonos)", MENU_KIND_CARD, on_kind_selected, app);
    submenu_add_item(app->menu_kind, "Demo (one song)", MENU_KIND_DEMO, on_kind_selected, app);

    /* Header is replaced with the chosen kind on entry; this is only what shows if that never ran. */
    submenu_set_header(app->menu_albums, app->from_csv ? "Pick an album" : "No list on SD");
    for(size_t i = 0; i < app->album_count; i++) {
        submenu_add_item(app->menu_albums, app->albums[i].label, i, on_album_selected, app);
    }

    view_dispatcher_attach_to_gui(app->view_dispatcher, app->gui, ViewDispatcherTypeFullscreen);
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, on_custom_event);
    view_dispatcher_add_view(app->view_dispatcher, ViewMenuMain, submenu_get_view(app->menu_main));
    view_dispatcher_add_view(app->view_dispatcher, ViewMenuKind, submenu_get_view(app->menu_kind));
    view_dispatcher_add_view(
        app->view_dispatcher, ViewMenuAlbums, submenu_get_view(app->menu_albums));
    view_dispatcher_add_view(app->view_dispatcher, ViewPopup, popup_get_view(app->popup));

    view_set_previous_callback(submenu_get_view(app->menu_main), exit_app);
    view_set_previous_callback(submenu_get_view(app->menu_kind), back_to_main);
    view_set_previous_callback(submenu_get_view(app->menu_albums), back_to_kind);
    view_set_previous_callback(popup_get_view(app->popup), back_to_main);

    view_dispatcher_switch_to_view(app->view_dispatcher, ViewMenuMain);
    return app;
}

static void app_free(App* app) {
    if(app->worker) {
        furi_thread_join(app->worker);
        furi_thread_free(app->worker);
    }
    view_dispatcher_remove_view(app->view_dispatcher, ViewMenuMain);
    view_dispatcher_remove_view(app->view_dispatcher, ViewMenuKind);
    view_dispatcher_remove_view(app->view_dispatcher, ViewMenuAlbums);
    view_dispatcher_remove_view(app->view_dispatcher, ViewPopup);
    submenu_free(app->menu_main);
    submenu_free(app->menu_kind);
    submenu_free(app->menu_albums);
    popup_free(app->popup);
    view_dispatcher_free(app->view_dispatcher);
    furi_event_flag_free(app->job_done);
    furi_record_close(RECORD_GUI);
    free(app);
}

int32_t marquee_tag_writer_app(void* p) {
    UNUSED(p);
    App* app = app_alloc();
    view_dispatcher_run(app->view_dispatcher);
    app_free(app);
    return 0;
}

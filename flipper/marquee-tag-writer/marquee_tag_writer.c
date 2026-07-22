/*
 * Marquee Tag Writer — Flipper Zero app (Route B, issue #68). SCAFFOLD, not finished.
 *
 * Goal: pick an album from a Curator-exported list and write its `curator:album:<id>` NDEF URI to a
 * blank NTAG213 in one tap. See docs/specs/flipper-tag-writer.md.
 *
 * What's real here: `marquee_build_ndef_tlv()` — the exact byte layout Stylus reads and Curator's
 * Route A generates (keep it byte-identical). What's stubbed: the NFC write (`nfc_write_ntag_pages`)
 * and loading the pending list from SD — both firmware-version-sensitive; see the TODOs and spec §6.
 *
 * Build: `ufbt` / `ufbt launch` (README.md).
 */
#include <furi.h>
#include <gui/gui.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/popup.h>

#define TAG "MarqueeTagWriter"
#define CURATOR_ID_LEN 8
#define MAX_ALBUMS 64

/* ---------------------------------------------------------------------------------------------
 * NDEF — the portable, tested-by-contract core. Mirrors packages/curator/src/tags/flipper-nfc.ts
 * (ndefUriTlv) exactly; do not diverge. Produces:  03 <len> D1 01 <plen> 55 00 <ascii> FE
 * Returns the TLV length, or 0 if it wouldn't fit `out_cap`.
 * --------------------------------------------------------------------------------------------- */
static size_t marquee_build_ndef_tlv(const char* curator_id, uint8_t* out, size_t out_cap) {
    // URI = "curator:album:" + <8-char id>  → 22 bytes.
    char uri[32];
    int uri_len = snprintf(uri, sizeof(uri), "curator:album:%s", curator_id);
    if(uri_len <= 0) return 0;

    const uint8_t payload_len = (uint8_t)(1 + uri_len); // 0x00 prefix + ascii
    const uint8_t record_len = (uint8_t)(4 + payload_len); // hdr,typelen,plen,type + payload
    const size_t tlv_len = 2 + record_len + 1; // 03,len + record + FE
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

/* ---------------------------------------------------------------------------------------------
 * App state
 * --------------------------------------------------------------------------------------------- */
typedef struct {
    char curator_id[CURATOR_ID_LEN + 1];
    char label[48]; // "name — artist"
} AlbumItem;

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    Submenu* submenu;
    Popup* popup;
    AlbumItem albums[MAX_ALBUMS];
    size_t album_count;
    size_t selected;
} App;

typedef enum {
    ViewSubmenu,
    ViewPopup,
} AppView;

/* ---------------------------------------------------------------------------------------------
 * TODO(#68): load the pending list from SD. Curator writes it (spec §3), e.g.
 *   /ext/apps_data/marquee_tag_writer/pending.csv  →  "curatorId,name,artist" lines.
 * Use the Storage record + a File; parse CSV into app->albums. Stubbed here with sample data so the
 * menu renders during scaffolding.
 * --------------------------------------------------------------------------------------------- */
static void load_pending_albums(App* app) {
    app->album_count = 0;
    // --- sample data (remove once CSV loading lands) ---
    strncpy(app->albums[0].curator_id, "2k7bxq9m", CURATOR_ID_LEN + 1);
    strncpy(app->albums[0].label, "Purple Rain — Prince", sizeof(app->albums[0].label) - 1);
    app->album_count = 1;
}

/* ---------------------------------------------------------------------------------------------
 * TODO(#68): write `tlv` into NTAG213 user pages (page 4+) of a held tag, then read back and verify
 * the URI parses. THIS IS THE FIRMWARE-SENSITIVE PART (spec §6):
 *   - open the NFC HAL / NfcDevice, run the Iso14443_3a + MfUltralight poller,
 *   - write 4-byte pages starting at page 4 with the TLV bytes (zero-pad the last page),
 *   - never touch lock/CC/PWD pages.
 * Get a bare "write one page" working against your firmware's headers first, then feed the TLV.
 * Returns true on a verified write.
 * --------------------------------------------------------------------------------------------- */
static bool nfc_write_ntag_pages(const uint8_t* tlv, size_t tlv_len) {
    UNUSED(tlv);
    UNUSED(tlv_len);
    FURI_LOG_W(TAG, "nfc_write_ntag_pages: not implemented (scaffold) — see spec §6");
    return false;
}

static void on_album_selected(void* context, uint32_t index) {
    App* app = context;
    if(index >= app->album_count) return;
    app->selected = index;

    uint8_t tlv[64];
    size_t tlv_len = marquee_build_ndef_tlv(app->albums[index].curator_id, tlv, sizeof(tlv));
    FURI_LOG_I(TAG, "built %zu-byte NDEF TLV for %s", tlv_len, app->albums[index].curator_id);

    popup_reset(app->popup);
    popup_set_header(app->popup, "Hold a blank\nNTAG213", 64, 10, AlignCenter, AlignTop);
    popup_set_text(app->popup, app->albums[index].label, 64, 34, AlignCenter, AlignTop);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewPopup);

    // TODO(#68): drive nfc_write_ntag_pages(tlv, tlv_len) from an NFC worker/scene and report
    // success/failure back to the popup instead of writing inline.
    bool ok = nfc_write_ntag_pages(tlv, tlv_len);
    popup_set_header(
        app->popup, ok ? "Written" : "Write TODO", 64, 10, AlignCenter, AlignTop);
}

static uint32_t exit_to_submenu(void* context) {
    UNUSED(context);
    return ViewSubmenu;
}

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    app->gui = furi_record_open(RECORD_GUI);
    app->view_dispatcher = view_dispatcher_alloc();
    app->submenu = submenu_alloc();
    app->popup = popup_alloc();

    load_pending_albums(app);
    submenu_set_header(app->submenu, "Marquee — write a tag");
    for(size_t i = 0; i < app->album_count; i++) {
        submenu_add_item(app->submenu, app->albums[i].label, i, on_album_selected, app);
    }

    view_dispatcher_attach_to_gui(
        app->view_dispatcher, app->gui, ViewDispatcherTypeFullscreen);
    view_dispatcher_add_view(app->view_dispatcher, ViewSubmenu, submenu_get_view(app->submenu));
    view_dispatcher_add_view(app->view_dispatcher, ViewPopup, popup_get_view(app->popup));
    view_set_previous_callback(popup_get_view(app->popup), exit_to_submenu);
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewSubmenu);
    return app;
}

static void app_free(App* app) {
    view_dispatcher_remove_view(app->view_dispatcher, ViewSubmenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewPopup);
    submenu_free(app->submenu);
    popup_free(app->popup);
    view_dispatcher_free(app->view_dispatcher);
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

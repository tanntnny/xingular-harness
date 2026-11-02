# Xingular Agent Brave bridge

This unpacked extension lets Harness use Brave's existing tabs through a short-lived loopback connection. It does not enable remote debugging on your profile and does not use Native Messaging.

## Install and connect

1. In Brave, open `brave://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select this `browser-extension` folder. In a packaged App install, use the unpacked extension folder shown in App Browser settings.
2. Select **Brave profile** in Harness Browser settings. This uses your signed-in profile, so pages may contain private account information. Harness will not switch to the isolated browser if Brave disconnects.
3. Choose **Start bridge** (or the equivalent connection action) in Harness Browser settings. Copy the one-time `port:code` shown there; it expires after five minutes.
4. Open the Xingular Agent extension from Brave's toolbar, paste the code, and connect.
5. Open a normal tab on the site you want Harness to use. Open the extension popup and choose **Allow this site**. Repeat only for sites you want the agent to reach.

The extension records the exact origin you allow, including its port, and checks that record for each tab. Chrome's underlying host permission can cover every port on that host, but other origins remain blocked by the extension. Incognito is disabled. The extension does not request cookie or history access. Site permission is separate from Harness tool permissions and from the per-action approvals for sending, buying, deleting, account changes, or granting access.

## Pause and stop

The in-page badge appears on allowed tabs while the bridge is connected. **Pause** prevents new browser calls until resumed; an action already in flight may finish. **Stop** disconnects the extension and removes the badge. Removing a site's permission in the extension popup also makes its tabs unavailable.

A lost connection makes Brave browser calls fail with a reconnect message. Harness does not fall back to its isolated browser.

## Permission warning

Brave requires the extension's `debugger` permission to inspect accessibility structure, capture screenshots, and send real input to a tab. Brave may show a broad permission warning at install time. The extension uses that ability only for normal tabs on sites you separately allowed in its popup. Close DevTools on a tab if Brave refuses debugger attachment. Do not install an unpacked extension from a source you do not trust.

The bridge listens only on `127.0.0.1`, accepts pairing only from a browser extension origin, and requires a random bearer token for each later call. It rejects a mismatched Origin when one is supplied; extension service-worker requests may omit Origin. The bridge stores its token in the Harness state directory with owner-only file permissions. The pairing code is not a permanent credential. The extension stores the token locally so it can reconnect after a normal Harness restart; **Stop** revokes it. Because Chrome host permissions do not narrow to ports, the extension keeps exact allowed origins separately and checks that list before exposing tabs; its loopback bridge permission alone never authorizes a site.

## Limits

- Only `http` and `https` sites can be granted. Browser-internal pages and Incognito tabs are unavailable.
- `browser_upload` stays with the App's isolated WebKit browser and is not offered while Brave is selected.
- Brave may refuse control of a tab while DevTools or another debugger is attached.
- A tab that leaves a site you allowed becomes unavailable to the agent until you separately allow its new site.

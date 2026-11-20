# Plenum for Chrome

Open the Plenum desktop app. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, then select this folder. Pin **Plenum for Chrome** if you want it in your toolbar.

Choose **Chrome** in the Plenum title bar and click **Get pairing code**. Paste the code into Plenum for Chrome. On a webpage, click **Share this tab** to share its title and address or highlight a passage and click **Share selected text**. In Plenum, review the share and choose **Add to chat draft**. The existing chat Send button submits the draft.

Tab shares omit URL credentials, query strings, and fragments. Selected text only comes from the top-level document. One share can wait for review for up to 15 minutes. The connection stays local to the desktop session. When Plenum restarts, the extension will ask for a new code on the next share. Use **Disconnect Chrome** in Plenum or **Disconnect** in Chrome to revoke the connection.

## Portfolio drafts

Open the **Plenum for Chrome** toolbar menu and choose **Open portfolio drafts**. Choose **Load this PC’s Plenum portfolio** to link the packet Plenum prepared on this PC, or import a JSON packet from another workspace. Choose a portfolio item, use **Copy** next to each field, and save its gallery images individually or as a ZIP. Enter the fields and upload the images in your portfolio editor. **Mark as entered** tracks your local progress. The panel remembers your current item and progress when you reopen Chrome.

The panel works without a desktop connection. Chrome stores one packet in this profile. The panel rereads a linked packet when it opens, and **Refresh from Plenum** reads it on demand. Selection survives reorders, and entered status survives for unchanged items. An invalid revision leaves the last valid packet open. Import a different packet or choose **Close packet** to remove the link. The panel does not read, fill, reload, or send requests to the portfolio site. See [Upwork’s automation rules](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly).

For packet authors, set `version` to `1` and provide an `items` array. Each item has `id`, `title`, `role`, `description`, `skills` and `images`. Each image uses `filename` and a PNG, JPEG or WebP `dataUrl`. Packets are limited to 7 MiB. Up to five skills and five images can be attached to each item.

For the local link, Plenum places `plenum-portfolio.local.json` next to `manifest.json` in the **unpacked** extension. Replace it atomically after validating each revision. The distributable ZIP omits this local file. A generic installation still supports manual import.

Each open Chrome window can view a different item. Entered marks are shared across windows. Reimporting the same packet keeps marks for unchanged items. Chrome checks that new gallery images open before replacing the saved packet.

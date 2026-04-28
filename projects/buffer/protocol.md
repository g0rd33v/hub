# buffer — protocol (v7)

A small folder for moving things between websites. Plain words, ten short rules.

---

## What this is

The buffer is a tiny workspace with **ten folders**. Each folder has a short name (10 letters and digits, e.g. `ab3kf02p1q`). When a Claude session uses the buffer, it picks one folder and works inside it.

The folder name is also the address. The folder name is also the write key. There is nothing else to remember.

## Two verbs

1. **Save here.** Write a file into the folder.
2. **Read from here.** Read any file in the folder.

That is the whole interface.

---

## When a session starts

1. The user pastes `https://drafts.labs.vc/buffer/` into the Claude extension chat.
2. Claude fetches `/buffer/manifest.json` and finds the first folder with state `open`.
3. Claude marks that folder as `in use` by writing `state.json` to it.
4. Claude tells the user the folder name in plain text, e.g. *"Using folder ab3kf02p1q."*
5. For the rest of the session, Claude saves and reads from that folder.

If every folder is in use, Claude tells the user and waits.

## Save here (write)

Endpoint: `POST https://drafts.labs.vc/drafts/upload`
Body (JSON): `{ "filename": "folders/<name>/<file>", "content": "<text or base64>" }`
Header: `Authorization: Bearer <folder-name>`

After uploading, also call:
- `POST /commit` with a short message
- `POST /promote` to publish

A folder is never published until `/promote` runs. Always promote.

After every save, refresh four small files in the folder:
- `files.json` — list of files, newest first, with size and time
- `latest.txt` and `latest.html` — copies of the most recent file under stable names
- `summary.txt` — one paragraph: what is in the folder right now
- `state.json` — `{ "status": "in use", "last_change": "...", "summary": "..." }`

## Read from here

Just `fetch` any URL under `/buffer/folders/<name>/`. The folder is public on a hard‑to‑guess address. No auth needed for reading.

For a fast read of what's inside, fetch `summary.txt` first, then `files.json` if details are needed.

## When a session ends

Mark the folder open again. Either keep the files (so the user can find them later) or clear them — the session decides based on what the user asked. Update `state.json` to `{ "status": "open" }` and call `/commit` then `/promote`.

## What to call things, in plain words

- *folder* — one of the ten small workspaces.
- *folder name* — the 10‑character address. Never `slot id`. Never `token`.
- *open* — nobody is using this folder. Free to take.
- *in use* — a session is working in this folder right now.
- *save here* — write a file. Never `copy to buffer`.
- *read from here* — read a file. Never `paste from buffer`.
- *summary* — one paragraph that says what is in the folder.
- *latest* — a stable address that always points at the most recent file.

## Privacy

Folder names are unguessable. `robots.txt` blocks crawlers from `/folders/`. Each folder page has `noindex, nofollow`. The root list does not include folder names — it only shows their state.

## End.

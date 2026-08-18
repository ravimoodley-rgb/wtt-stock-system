# Deploy WTT Stock System to Register Domain SA (cPanel + CloudLinux Node.js)

App: Witbank Tank Terminals stock management system.
Domain: www.witbankterminals.co.za
Host: Register Domain SA — 5 GB Node.js plan (cPanel / CloudLinux Node.js Selector).

Important: this app uses Node's built-in `node:sqlite`, which only works on
**Node 22 or 24** (NOT 19 or 20). The database lives in `data/wtt.db` next to
the app code, so it persists on the disk across restarts.

---

## 1. DNS (do this first, takes time to propagate)

1. Log in to Register Domain SA account and open **Domains** → manage
   `witbankterminals.co.za`.
2. Make sure the **nameservers** are set to Register Domain SA's own
   nameservers (if hosting was bought in the same account, they usually are).
3. If the domain is NOT yet attached to your hosting account, add it in cPanel
   (**Home → Domains**) or ask support to attach `witbankterminals.co.za` to
   your account. This creates the DNS zone automatically.
4. In cPanel **Zone Editor** confirm there are records:
   - `www`  → A → your hosting server IP
   - (apex) → A → your hosting server IP (or CNAME)
   - `@`    → MX → optional, only if you want email.

Check propagation with: `nslookup www.witbankterminals.co.za` — wait until it
returns the server IP before going live (can take a few hours for .co.za).

## 2. Upload the app

1. cPanel **File Manager** → go to your home directory (e.g. `/home/USERNAME`).
2. Create a folder: **`wtt`**.
3. Open `wtt`, use **Upload**, and upload `wtt-deploy.zip`.
4. Right-click the zip → **Extract** (all files land in `wtt`).
   Verify you see `server.js`, `db.js`, `package.json`, `public/`, `data/`.

## 3. Create the Node.js app in cPanel

1. In cPanel, open **Setup Node.js App**.
2. Click **Create Application**:
   - Application root: `wtt`  (or `/home/USERNAME/wtt`)
   - Application URL: select `www.witbankterminals.co.za` from the dropdown.
   - Application startup file: `server.js`
   - Application name: `wtt` (anything)
   - **Application mode: Production**
   - **Node.js version: 24.x** (22.x also OK — must be 22.5+)
3. **Save / Create**. CloudLinux assigns the port and passes it to the app via
   the `PORT` environment variable — the app already reads it, no code change.
4. In the app's row, click **Run NPM Install** (uses `package-lock.json`).
5. Click **Restart** to start the app.

## 4. SSL (HTTPS)

1. cPanel **SSL/TLS Status** → select the domain → **Run AutoSSL** (or "Issue").
   Certificate should cover `witbankterminals.co.za` AND `www.witbankterminals.co.za`.
2. Optional but recommended: in cPanel **Redirects** add
   `https://www.witbankterminals.co.za` → same URL with https (force HTTPS).
   The app also sends HSTS/HTTPS headers already.

## 5. Test

Open https://www.witbankterminals.co.za — you should see the login screen.
Log in: `admin` / `admin123`.

## 6. Notes

- Data persists in `wtt/data/wtt.db` on the disk. Back it up with cPanel's
  nightly backups or download `data/wtt.db` manually now and then.
- To update the app later: overwrite the files in `wtt/`, **Restart** the app
  in Setup Node.js App.
- Keep Render (https://wtt-stock-system.onrender.com) running as a fallback
  until the new domain is verified end to end.

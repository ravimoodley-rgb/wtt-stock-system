# Deploying to Render

This project is ready to deploy on Render (free tier) with a custom domain.

## 1. Push the code to GitHub

Git is required on your machine.

```bash
# install Git from https://git-scm.com (then reopen the terminal)

cd C:\Users\ravim\wttonline
git init
git add .
git commit -m "Initial commit - WTT stock system"
```

Create a repository at https://github.com/new (do NOT tick "Add a README") and then:

```bash
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/wtt-stock-system.git
git push -u origin main
```

## 2. Create the service on Render

1. Go to https://dashboard.render.com and sign up (free).
2. Click **New** → **Blueprint** → **Public repository**.
3. Paste your GitHub repo URL and connect it.
4. Render reads `render.yaml` and creates the web service automatically.
5. Click **Apply**. It builds and starts. The first deploy takes a few minutes.

## 3. Add your custom domain

1. In Render, open your service → **Settings** → **Custom Domain**.
2. Click **Add Custom Domain**, enter `www.yourdomain.co.za` (and again for the bare domain if wanted).
3. Render shows a DNS target like `your-app.onrender.com` (a CNAME).
4. At your domain registrar, add a DNS record:
   - Type: **CNAME**
   - Name: `www` (or `@` / your host if the registrar requires it)
   - Value: `your-app.onrender.com`
5. Wait for DNS to propagate (a few minutes to a few hours).
6. Render automatically issues a free HTTPS certificate once the record is live.

## 4. Final checks

- Open `https://www.yourdomain.co.za` and sign in.
- **Immediately change the admin password** (`admin` / `admin123` is the default and is warned about on startup).
- The SQLite database lives on Render's persistent disk (`/app/data/wtt.db`) and survives redeploys.

## Notes

- Free-tier services sleep after inactivity; the first load after sleep takes ~30s. Set a health check
  or upgrade to keep it always-on if needed.
- Back up the database by downloading `data/wtt.db` from the Render dashboard (Shell/Console tab) or a scheduled job.
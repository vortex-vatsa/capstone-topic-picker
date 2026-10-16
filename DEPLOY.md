# Deploy to GitHub Pages

About five minutes. The database (Supabase) is already set up; this only publishes the page.

## 1. Create the repository

On <https://github.com/new>:

- **Repository name:** `capstone-topic-picker`
- **Public** (GitHub Pages on a free account needs a public repo; nothing secret is in here)
- Leave "Add a README", ".gitignore" and "license" **unticked** (they already exist here)
- Click **Create repository**

## 2. Push this folder

In Terminal, replace `YOUR-USERNAME` with your GitHub username:

```bash
cd /Users/aaryan.vatsa/Downloads/experiments/capstone-topic-picker
git init
git add .
git status
git commit -m "Capstone topic picker: sealed ranking and fair allocation"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/capstone-topic-picker.git
git push -u origin main
```

`git status` should list `index.html`, `css/`, `js/`, `fonts/`, `supabase/`, `tests/`, `docs/` and the
Markdown files, and **not** `supabase.zip` or `.DS_Store` (`.gitignore` excludes them).

## 3. Turn on Pages

In the repository: **Settings → Pages**

- **Source:** Deploy from a branch
- **Branch:** `main`, folder `/ (root)` → **Save**

After 1–2 minutes the page is live at:

```
https://YOUR-USERNAME.github.io/capstone-topic-picker/
```

## 4. Check it before sharing

1. Open the link on your phone.
2. Claim a slot with a test name and PIN, rank two questions, save.
3. Open **Manage → Release slot** to delete it again.

## Updating later

Edit files, then:

```bash
git add .
git commit -m "Describe the change"
git push
```

The live page updates within a couple of minutes.

## Message for the group

> Topic allocation for the Lindt capstone: https://YOUR-USERNAME.github.io/capstone-topic-picker/
>
> One rep per group: claim a slot, add your members, set a PIN (keep it, you need it to edit), and
> rank the questions you want, as many as you like. Rankings stay hidden until all six groups have
> submitted; then the fairest allocation appears for everyone. Please submit by 20:00 tonight.

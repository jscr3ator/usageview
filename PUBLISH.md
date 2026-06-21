# Publishing UsageView

Run the release checks first:

```powershell
npm install
npm run publish:check
```

Create the installer:

```powershell
npm run dist
```

Initialize Git if this folder is not a repo yet:

```powershell
git init
git add .
git commit -m "Initial UsageView release"
```

Create an empty GitHub repo, then connect it:

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_NAME/usageview.git
git push -u origin main
```

Before pushing, make sure these are not committed:

- `.env`
- `data/`
- `release/`
- screenshots with local IPs or display keys

Those paths are already ignored by `.gitignore`.

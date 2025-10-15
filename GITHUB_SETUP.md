Quick GitHub Setup

Push to GitHub:
```
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Auto-build on GitHub:

Every push to main builds Windows .exe and Linux AppImage automatically.

Download builds:
1. Go to Actions tab on GitHub
2. Click latest workflow run
3. Download windows-installer or linux-appimage

Make a release:
```
git tag v0.1.0
git push origin v0.1.0
```

This creates a GitHub Release with downloadable installers.


# CloudSurf Action

Runs browser automation scripts against Chrome profiles in a GitHub Actions runner. No Codespace, no VNC, no keepalive tricks — just short, purposeful bursts.

## How it works

1. **cron-job.org** triggers the `workflow_dispatch` every N minutes
2. The action downloads your profiles zip from Google Drive, installs Chrome, and launches one headless Chrome per profile
3. The chosen script runs against all profiles in parallel via Puppeteer CDP
4. The action exits after `run_time` seconds — Chrome processes are killed by the runner cleanup

For scripts like `colab_run_all`: Colab keeps the notebook alive for 5–10 min after the action exits. Trigger again before it idles.

## Secrets

| Secret | Description |
|---|---|
| `PROFILES_ZIP_URL` | Public shareable Google Drive direct-download URL for your profiles zip |
| `CLOUDSURF_NOTEBOOK` | Colab notebook name (passed to `colab_run_all.js`) |

### Google Drive URL format

Get a shareable link from Drive, then convert it:

```
Shareable link:  https://drive.google.com/file/d/FILE_ID/view?usp=sharing
Direct download: https://drive.google.com/uc?export=download&id=FILE_ID
```

Use the direct-download URL as `PROFILES_ZIP_URL`.

## Profiles zip format

Zip your `profiles/` folder so the structure inside is:

```
profiles.zip
└── profile_one/
│   └── chrome/          ← Chrome user-data-dir (cookies, localStorage, etc.)
└── profile_two/
    └── chrome/
```

The zip can optionally include a single top-level wrapper folder — the launcher handles both formats.

## Adding scripts

Drop any `.js` file into `scripts/`. It receives these env vars:

| Var | Value |
|---|---|
| `CLOUDSURF_CDP_PORT` | CDP port for this profile's Chrome |
| `CLOUDSURF_CDP_URL` | `ws://127.0.0.1:<port>` |
| `CLOUDSURF_PROFILE_ID` | Profile directory name |

Connect with `puppeteer.connect({ browserURL: \`http://127.0.0.1:${process.env.CLOUDSURF_CDP_PORT}\` })`.

## Triggering via cron-job.org

Use the GitHub API endpoint:

```
POST https://api.github.com/repos/YOUR_USER/CloudSurf/actions/workflows/cloudsurf.yml/dispatches
Authorization: Bearer YOUR_PAT
Content-Type: application/json

{
  "ref": "main",
  "inputs": {
    "script": "colab_run_all",
    "run_time": "300"
  }
}
```

Set this as a cron-job.org HTTP job on whatever interval you need.

## Adjusting run time

- `run_time` (workflow input): seconds the scripts are allowed to run **after** Chrome is up. Setup takes ~2–3 min; this is on top of that.
- `timeout-minutes` (in the workflow file): total job cap. Increase if you need very long runs. GitHub Actions max is 360 min.

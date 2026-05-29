#!/usr/bin/env python3
"""
CloudSurf Action Launcher
Starts one headless Chrome per profile, runs the chosen script(s) against each,
then exits. No Flask, no VNC, no keepalive threads.

Usage (called by the workflow):
  python launch.py

Env vars (set by the workflow):
  CLOUDSURF_SCRIPT       script name or comma-separated list of script names,
                         e.g. "colab_run_all" or "youtube_warmup,colab_keep_alive"
                         Scripts are run sequentially per profile in the order given.
  CLOUDSURF_NOTEBOOK     notebook name passed through to colab_run_all.js
  CLOUDSURF_RUN_TIME     seconds to let scripts run before hard exit (default: 300)
  PROFILES_DIR           path to unzipped profiles (default: ./profiles)
"""

import os, sys, time, subprocess, threading, signal
from pathlib import Path

PROFILES_DIR  = Path(os.environ.get("PROFILES_DIR", "./profiles"))
SCRIPTS_DIR   = Path(__file__).parent / "scripts"
# Support comma-separated list of script names; strip whitespace around each entry
SCRIPT_NAMES  = [s.strip() for s in os.environ.get("CLOUDSURF_SCRIPT", "colab_run_all").split(",") if s.strip()]
RUN_TIME      = int(os.environ.get("CLOUDSURF_RUN_TIME", "300"))  # seconds

# CDP base port — each profile gets its own (9222, 9223, …)
CDP_BASE      = 9222
CHROME_FLAGS  = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--no-first-run", "--no-default-browser-check",
    "--disable-infobars", "--disable-session-crashed-bubble",
    "--disable-features=TranslateUI",
    "--window-size=1280,900",
    "--disable-background-networking",
    "--headless=new",          # try proper headless first
]

def log(msg):
    print(f"[launch] {msg}", flush=True)

def find_chrome():
    for candidate in [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
    ]:
        if Path(candidate).exists():
            return candidate
    raise RuntimeError("Chrome not found — install google-chrome-stable first")

def discover_profiles():
    """Return sorted list of profile directory names."""
    if not PROFILES_DIR.exists():
        raise RuntimeError(f"Profiles dir not found: {PROFILES_DIR}")
    profiles = sorted(
        p.name for p in PROFILES_DIR.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    )
    if not profiles:
        raise RuntimeError(f"No profiles found in {PROFILES_DIR}")
    return profiles

def start_chrome(profile_id, cdp_port, chrome_bin):
    profile_path = PROFILES_DIR / profile_id / "chrome"
    profile_path.mkdir(parents=True, exist_ok=True)
    cmd = [
        chrome_bin,
        f"--user-data-dir={profile_path}",
        f"--remote-debugging-port={cdp_port}",
        "--remote-debugging-address=127.0.0.1",
        *CHROME_FLAGS,
        "about:blank",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log(f"  Chrome started for {profile_id} (pid={proc.pid}, cdp={cdp_port})")
    return proc

def wait_for_cdp(cdp_port, timeout=20):
    """Poll until Chrome's CDP endpoint is accepting connections."""
    import urllib.request, urllib.error
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/version", timeout=2)
            return True
        except Exception:
            time.sleep(0.5)
    return False

def run_script(script_name, profile_id, cdp_port):
    """Run a single named script against the given profile's Chrome instance."""
    script_file = script_name if script_name.endswith(".js") else script_name + ".js"
    script_path = SCRIPTS_DIR / script_file
    if not script_path.exists():
        log(f"  ERROR: script not found: {script_path}")
        return 1

    env = {
        **os.environ,
        "CLOUDSURF_CDP_PORT":   str(cdp_port),
        "CLOUDSURF_CDP_URL":    f"ws://127.0.0.1:{cdp_port}",
        "CLOUDSURF_PROFILE_ID": profile_id,
    }
    log(f"  Running {script_file} for {profile_id} ...")
    result = subprocess.run(
        ["node", str(script_path)],
        env=env,
        cwd=str(SCRIPTS_DIR),
    )
    log(f"  {script_file} for {profile_id} exited rc={result.returncode}")
    return result.returncode

def profile_worker(profile_id, cdp_port, chrome_bin):
    log(f"[{profile_id}] Starting ...")
    chrome = start_chrome(profile_id, cdp_port, chrome_bin)

    if not wait_for_cdp(cdp_port):
        log(f"[{profile_id}] CDP never came up — skipping scripts")
        chrome.terminate()
        return

    # Run all scripts in parallel threads
    script_threads = []
    for script_name in SCRIPT_NAMES:
        log(f"[{profile_id}] --- Launching script in parallel: {script_name} ---")
        t = threading.Thread(target=run_script, args=(script_name, profile_id, cdp_port), daemon=True)
        t.start()
        script_threads.append(t)

    # Wait for all scripts for this profile to finish
    for t in script_threads:
        t.join()

    # Don't terminate Chrome — let GH Actions kill everything on exit
    # so Colab/etc. stays alive in its own session after we disconnect.

def main():
    log(f"Scripts:  {', '.join(SCRIPT_NAMES)}")
    log(f"Run time: {RUN_TIME}s (hard exit after this)")
    log(f"Profiles: {PROFILES_DIR}")

    chrome_bin = find_chrome()
    log(f"Chrome:   {chrome_bin}")

    # Validate all scripts exist before launching any Chrome instances
    missing = []
    for script_name in SCRIPT_NAMES:
        script_file = script_name if script_name.endswith(".js") else script_name + ".js"
        script_path = SCRIPTS_DIR / script_file
        if not script_path.exists():
            missing.append(str(script_path))
    if missing:
        raise RuntimeError(f"Script(s) not found: {', '.join(missing)}")

    profiles = discover_profiles()
    log(f"Found {len(profiles)} profile(s): {profiles}")

    # Install node deps if needed
    pkg_json = SCRIPTS_DIR / "package.json"
    nm = SCRIPTS_DIR / "node_modules"
    if pkg_json.exists() and not nm.exists():
        log("Installing Node deps ...")
        subprocess.run(["npm", "install", "--prefix", str(SCRIPTS_DIR)], check=True)

    # Launch all profiles in parallel threads
    threads = []
    for i, pid in enumerate(profiles):
        cdp_port = CDP_BASE + i
        t = threading.Thread(target=profile_worker, args=(pid, cdp_port, chrome_bin), daemon=True)
        t.start()
        threads.append(t)
        time.sleep(1.5)  # stagger slightly to avoid port-race

    log(f"All profiles launched. Waiting up to {RUN_TIME}s ...")

    # Hard exit after RUN_TIME regardless — workflow controls total runtime
    deadline = time.time() + RUN_TIME
    for t in threads:
        remaining = deadline - time.time()
        if remaining > 0:
            t.join(timeout=remaining)

    log("Run time elapsed — exiting.")

if __name__ == "__main__":
    main()

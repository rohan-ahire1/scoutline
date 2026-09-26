# Nightly discovery

`scoutline-nightly.timer` runs `scoutline-nightly.mjs` at 02:00 America/Denver.
Each night it discovers one slice of the SLC market (2 areas x 3 trade
categories, 25 records per area) through `/api/markets/slc/discover`, then
waits for the runs and their qualify/visual jobs and logs a summary. The slice
rotates (areas first, categories when areas wrap), so a full pass over 10 areas
x 12 categories takes 20 nights. Without `BRIGHT_DATA_API_KEY` it only rescores
saved leads.

Install (the script lives outside `releases/` so deploys don't touch it):

    install -D -m 644 ops/nightly/scoutline-nightly.mjs /home/rohan/projects/scoutline/ops-nightly/scoutline-nightly.mjs
    sudo install -m 644 ops/systemd/scoutline-nightly.{service,timer} /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now scoutline-nightly.timer

Logs: `journalctl -u scoutline-nightly -n 100`. Next run: `systemctl list-timers scoutline-nightly`.
Run now: `sudo systemctl start --no-block scoutline-nightly`. Dry run (no discovery):
`bws run ... -- node scoutline-nightly.mjs --dry-run`.
Rotation state: `~/.local/state/scoutline-nightly/state.json`.

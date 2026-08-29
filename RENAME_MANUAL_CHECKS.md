# Repository Rename: Manual Checks

This file is published with the static Telegram Mini App. It covers the
rename to `telegram-voice-assistant` and `telegram-voice-assistant-static`.
Do not put secret values in this repository.

## GitHub Pages

- [ ] Confirm the site loads at `https://kamelotmarmot.github.io/telegram-voice-assistant-static/` over HTTPS.
- [ ] Confirm GitHub Pages publishes the `main` branch root directory.
- [ ] Confirm the static deployment workflow succeeds after backend changes.
- [ ] Confirm `version.js` matches the deployed backend build.

## Backend And Telegram Configuration

- [ ] Update `STATIC_GH_REPO` in the private backend repository to `KaMeLoTmArMoT/telegram-voice-assistant-static`.
- [ ] Confirm the backend `GH_PAT` can push to this repository.
- [ ] Update the backend runtime `TMA_URL` to the final Pages URL.
- [ ] Update the Telegram BotFather Web App/menu button URL.
- [ ] Confirm backend CORS allows the final Pages origin.
- [ ] Confirm the frontend receives the API endpoint through the `api_url` query parameter.

## Security

- [ ] Confirm no bot token, API key, AWS credential, or private URL is present in the published files.
- [ ] Confirm no secret is passed through frontend JavaScript or URL query parameters.
- [ ] Confirm the old Pages URL is no longer used by Telegram or backend runtime configuration.

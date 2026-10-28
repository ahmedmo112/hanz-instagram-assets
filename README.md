# Hanz Instagram autopost

Publishes the Hanz Instagram posts (days 2–30) to **@hanz.agent** on schedule. Day 1 is scheduled in Meta Business Suite.

- `posts.json`: each post's day, publish time (UTC, with the Eastern Time in `et`), image links and caption
- `images/`: the JPEGs Instagram downloads (they must stay public)
- `post.mjs`: publishes the next due post through the Instagram Graph API, at most one per run
- `posted.json`: what has been published, with links. The workflow commits it after each post.
- `.github/workflows/autopost.yml`: runs every 15 minutes. GitHub can start it up to about 15–30 minutes late.

## Setup
1. Add the token as a secret: **Settings → Secrets and variables → Actions → New repository secret**, name `META_ACCESS_TOKEN`.
2. Test it: **Actions → Instagram autopost → Run workflow** with "Dry run" ticked. It checks every image and the token and publishes nothing.
3. Turn it on: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `AUTOPOST_ENABLED`, value `true`.

## Day to day
- **Pause:** set `AUTOPOST_ENABLED` to `false` (or disable the workflow in the Actions tab).
- **Change a post:** edit its caption or time in `posts.json`, or replace its image in `images/`, before it goes out.
- **Skip a post:** add its id to `posted.json` by hand, or remove it from `posts.json`.
- **Something failed:** the run turns red and GitHub emails you. Nothing is retried on its own until the next run, and a post already on the account is never posted twice.
- **Token expiry:** a Graph API Explorer token lasts about 60 days, which covers this schedule. A System User token doesn't expire.

# Sonilo JavaScript SDK

This monorepo hosts the official Sonilo packages for JavaScript/TypeScript.

| Package | Description | npm |
| --- | --- | --- |
| [`sonilo`](./packages/sonilo) | Official TypeScript/JavaScript client. Zero runtime dependencies, works in Node.js ≥ 18 and modern browsers. | `npm install sonilo` |
| [`sonilo-video-kit`](./packages/sonilo-video-kit) | Node-only helpers to generate a soundtrack for a video and mix it in locally with ffmpeg. | `npm install sonilo sonilo-video-kit` |

## Development

This is an npm workspaces monorepo.

```bash
npm install          # install all workspaces
npm run build        # build every package (core first)
npm test             # build core, then test every package
```

`sonilo-video-kit` requires `ffmpeg` + `ffprobe` on your PATH for its tests.

## Releases

Releases are managed with [changesets](https://github.com/changesets/changesets)
and published to npm via GitHub Actions OIDC trusted publishing.

1. Add a changeset describing your change: `npx changeset`
2. Merge to `main`. The Release workflow opens a "Version Packages" PR.
3. Merge that PR to publish the bumped packages.

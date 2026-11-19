# AICMS on Cloudflare Workers

Studio, REST, GraphQL, MCP, A2A and live events in one Worker: data in D1, media in R2, Studio from Workers Assets.

```bash
npm install
cp .dev.vars.example .dev.vars          # set a long random AICMS_OWNER_TOKEN
npm run dev                             # wrangler dev with local D1 and R2
```

Sign in to Studio with a one-time link:

```bash
npx aicms login --url http://localhost:8787 --token <AICMS_OWNER_TOKEN>
```

Issue a token for an agent (or use Studio → Agents):

```bash
curl -X POST http://localhost:8787/api/v1/actions/cms.token \
  -H "authorization: Bearer <AICMS_OWNER_TOKEN>" -H "content-type: application/json" -d '{"agent":"writer"}'
```

Deploy:

```bash
npx wrangler d1 create aicms            # put the id into wrangler.jsonc
npx wrangler r2 bucket create aicms-media
npx wrangler secret put AICMS_OWNER_TOKEN
npm run deploy
```

On the edge, models are listed in `aicms.config.ts` (there is no folder to scan), installs from Studio aren't written back to the config, and live events and presence are per Worker instance. git-sync needs a file system and doesn't run here.

# Put Fruit Fuse Arena Online

Fruit Fuse Arena needs a Node.js web service because multiplayer uses WebSockets. A static HTML-only host will not run the game server.

## Option A: Render

1. Create a GitHub repository and upload everything inside the `fruit-fuse-arena` folder.
2. Sign in to Render and choose **New → Blueprint**.
3. Select the repository. Render reads `render.yaml` automatically.
4. Finish creating the service, then open the assigned `https://...onrender.com` address.
5. Create a room and click **Copy invite link**.

The included Blueprint runs `npm ci`, starts the game with `npm start`, and uses `/health` for deployment health checks.

## Option B: Railway

1. Create a GitHub repository and upload everything inside the `fruit-fuse-arena` folder.
2. In Railway, choose **New Project → Deploy from GitHub repo** and select it.
3. Railway reads `railway.json` and starts the game with `npm start`.
4. Open the service settings, go to **Networking**, and choose **Generate Domain**.
5. Open that domain, create a room, and click **Copy invite link**.

You can also deploy from the project directory with the Railway CLI using `railway up`.

## Important limitation

Rooms and scores are stored in server memory. A host restart, redeploy, or free-service sleep clears active rooms. Run only one server instance unless shared multiplayer state is added later.

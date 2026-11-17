# Editing and publishing AzaadAI

Everything here can be done from a web browser. You don't need to install anything.

## 1. Get access (once)

Make a free account at [github.com](https://github.com/signup) and send Sehaj your username. He'll add you to this repository, and you'll get an email invite to accept.

## 2. How publishing works

This repository **is** the site. When a change is saved ("committed") to the `main` branch, GitHub rebuilds the site and puts it live at [sehajr-singhs.github.io/azaadai-web](https://sehajr-singhs.github.io/azaadai-web/) about a minute later. You can watch it under the [Actions tab](https://github.com/sehajr-singhs/azaadai-web/actions): a green tick means it's live, a red cross means the change broke the build and the old site stays up.

## 3. Making a change

1. Open the file on GitHub (see the table below).
2. Click the pencil icon (top right of the file) to edit it.
3. Click **Commit changes**, write a line saying what you changed, and commit to `main`.

For bigger edits across several files, press the `.` key on the repository page. That opens a full editor in the browser.

To undo a change, open the file, click **History**, open the change you want gone, and copy the old text back in. You can also ask Sehaj to revert it.

## 4. What lives where

| You want to change | Edit this file | Live after |
|---|---|---|
| How the model talks, what it holds, its rules and boundaries | [`prompts/azaad.md`](prompts/azaad.md) | about 10 minutes |
| The Council / Swarm voices | [`prompts/council.md`](prompts/council.md) | about 10 minutes |
| Home page text (hero, sections, Swarm, Terminal, footer) | [`src/pages/Home.tsx`](src/pages/Home.tsx) | about 1 minute |
| The Ask page (example questions, wording around the chat) | [`src/pages/Ask.tsx`](src/pages/Ask.tsx); the example questions are `SUGGESTIONS` at the top | about 1 minute |
| Header, logo, navigation | [`src/components/brand.tsx`](src/components/brand.tsx) | about 1 minute |
| Page title and description shown in Google and link previews | [`index.html`](index.html) | about 1 minute |
| Paintings and images | [`public/img/`](public/img) (upload a file with the same name to replace one) | about 1 minute |
| Colours and fonts | [`tailwind.config.js`](tailwind.config.js) | about 1 minute |

In the `.tsx` files, only change the words between the tags, so the code around them stays intact. If you're unsure, change one thing, commit, and check the site.

## 5. Things that update themselves

- **The library.** AzaadAI re-reads bungaazaadi.com every 24 hours, so a new paper published there becomes searchable on its own. The research model sees everything; the public model sees only the four core papers.
- **The model's instructions.** The two files in `prompts/` are re-read from the live site about every 10 minutes, so you don't need anyone to redeploy anything.

## 6. Things that still go through Sehaj

These touch paid infrastructure or need retraining:
- the model itself (retraining on new material, switching models)
- GPU settings: speed, cold starts, cost, keeping it always on
- access codes for the research model (one per group if you want)
- the gateway code in `server/`, which runs on Modal

## 7. Running it on your own computer (optional)

Only needed for big redesigns. Install [Node.js](https://nodejs.org), then:

```
git clone https://github.com/sehajr-singhs/azaadai-web.git
cd azaadai-web
npm install
VITE_AZAAD_URL=https://sehajr-singhs--azaad-gateway-web.us-east.modal.run npm run dev
```

and open http://localhost:5173. On Windows PowerShell, set the variable first with `$env:VITE_AZAAD_URL="https://sehajr-singhs--azaad-gateway-web.us-east.modal.run"`, then run `npm run dev`.

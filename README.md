# Cartable

An open-source online classroom for children and their teachers. Teachers plan
classes on a calendar, then teach live with video, screen sharing and a shared
whiteboard. Students see their timetable and join with one click.

## Features

**Live classroom**
- Video and voice calls between the teacher and up to 15 students (peer-to-peer WebRTC)
- Screen sharing, shown big on everyone's stage automatically
- Shared whiteboard with colours, an eraser and a "show big" mode
- Chat, a big "raise hand" button, and emoji reactions
- Speaking indicator and pinning any video
- Teacher controls: mute one or everyone, lower a hand, remove someone, lock the class, lock the whiteboard, clear the board, end the class for everyone
- Attendance list of who joined and when
- Keyboard shortcuts: `M` microphone, `V` camera, `H` raise hand

**Timetable and calendar**
- Month calendar with colour-coded classes
- "Today" page with the next class, a countdown, and what to bring
- Weekly repeating classes (up to a whole school year)
- Students can join from 10 minutes before a class starts
- Invite links and class codes
- Download every class as an `.ics` file for Google Calendar, Outlook or Apple Calendar
- Works on phones and tablets

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. The default teacher code is `teach`. Change it:

```bash
# macOS / Linux
TEACHER_CODE=my-secret npm start
# Windows PowerShell
$env:TEACHER_CODE="my-secret"; npm start
```

## Putting it online

Browsers only allow the camera, microphone and screen sharing on `https://` (or
`localhost`). To use Cartable with other people, host it behind HTTPS, for example:

- A VPS with [Caddy](https://caddyserver.com) as a reverse proxy (automatic HTTPS)
- Render, Railway or Fly.io (they support WebSockets)
- For a quick test: `npx localtunnel --port 3000` or Cloudflare Tunnel

Video uses public STUN servers. Some school or company networks block direct
connections; for those, add a TURN server (such as the open-source
[coturn](https://github.com/coturn/coturn)) to `ICE` in `public/js/room.js`.

## How it is built

| Part | Technology |
| --- | --- |
| Server | Node.js, Express, Socket.IO (signaling, chat, whiteboard sync) |
| Video | WebRTC mesh: each person connects directly to everyone else |
| Frontend | Plain HTML, CSS and JavaScript, no build step |
| Storage | `data/db.json` (classes and attendance) |

A mesh works well for a class of about 10–16 people. For bigger classes, swap
the mesh for an open-source SFU such as [LiveKit](https://livekit.io) or
[mediasoup](https://mediasoup.org).

## Good to know

- Sign-in is a simple name plus a shared teacher code. Before using it with real
  children, add proper accounts (for example with your school's SSO) and review
  your local child privacy rules (GDPR, COPPA).
- Nothing is recorded. Video goes directly between browsers.

## License

MIT. See [LICENSE](LICENSE).

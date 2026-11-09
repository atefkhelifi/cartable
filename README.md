# Cartable

**Live app: [cartable-zd23.onrender.com](https://cartable-zd23.onrender.com)**

> Free hosting: the first visit after a quiet spell can take about a minute while the server wakes up.

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

**Languages**
- English and French, switchable at any time (EN / FR). French is chosen automatically for French browsers.
- To add a language, add a dictionary in `public/js/i18n.js`.

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

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/atefkhelifi/cartable)

1. Click the button above and sign in to Render with GitHub.
2. Click **Apply**. Render builds the app and gives you a link such as `https://cartable-xxxx.onrender.com`.
3. In Render, open the service, go to **Environment**, and copy `TEACHER_CODE`. That is the code teachers use to sign in.
4. Share the link (or a class invite link) with your students.

The free plan sleeps after 15 minutes without visitors (the first visit then takes
about a minute) and saved classes are wiped when the server restarts. For a real
school, switch to a paid plan and add a disk mounted at `/var/data` with
`DATA_DIR=/var/data`.

Browsers only allow the camera, microphone and screen sharing on `https://` (or
`localhost`); Render provides HTTPS automatically.

**Video on school or mobile networks.** Video uses public STUN servers, which work
on most home Wi-Fi. Some school, company and mobile networks block direct
connections; for those, add a TURN relay by setting `TURN_URLS`,
`TURN_USERNAME` and `TURN_CREDENTIAL` (for example a free
[Metered Open Relay](https://www.metered.ca/tools/openrelay/) account, or your
own [coturn](https://github.com/coturn/coturn) server).

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

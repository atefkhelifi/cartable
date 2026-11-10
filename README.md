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
- Shared whiteboard with colours, an eraser, a "show big" mode and "Save as image" (PNG) for teachers and students
- Chat, a big "raise hand" button, and emoji reactions
- Speaking indicator and pinning any video
- Teacher controls: mute one or everyone, lower a hand, remove someone, lock the class, lock the whiteboard, clear the board, end the class for everyone
- Attendance list of who joined and when
- Class recording (teacher only): records the class as the teacher sees it, with everyone's voices, and saves an MP4 (or WebM) to the teacher's computer. Everyone sees a red "Recording" badge while it runs. Works in Chrome and Edge on a computer; when Chrome asks, pick the Cartable tab and keep "Also share tab audio" on.
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
- English, French and Arabic, switchable at any time (EN / FR / ع). The language is chosen automatically from the browser.
- Arabic uses a full right-to-left layout and Arabic fonts (Baloo Bhaijaan 2, IBM Plex Sans Arabic).
- To add a language, add a dictionary in `public/js/i18n.js`.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer (Cartable uses the built-in `node:sqlite`).

```bash
npm install
npm start
```

Open http://localhost:3000. Teachers pick **Teacher → Create an account** and enter the school code, which is `teach` by default. Change it:

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
3. In Render, open the service, go to **Environment**, and copy `TEACHER_CODE`. That is the school code teachers need once, to create their account.
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
| Storage | SQLite file `data/cartable.db` (teachers, classes, attendance) |

A mesh works well for a class of about 10–16 people. For bigger classes, swap
the mesh for an open-source SFU such as [LiveKit](https://livekit.io) or
[mediasoup](https://mediasoup.org).

## Good to know

- **Teachers** have their own username and password. Creating an account needs
  the school code (`TEACHER_CODE`). In production, sign-up stays off until you
  set your own code. Each teacher sees and manages only their own classes.
- **Students** type only a name. They can join a class only with a real class
  link or code, and they see only the classes they have opened. Anyone holding a
  class link can join, so share links only with the class, and use **Lock class**
  once everyone is in.
- Upgrading from 1.1: on first start, `data/db.json` is imported and renamed to
  `db.json.migrated`. Existing classes go to the first teacher who creates an
  account.
- Attendance is deleted after 365 days. Change this with `ATTENDANCE_DAYS`.
- Review your local child privacy rules (GDPR, COPPA) before using Cartable with
  real children.
- Video goes directly between browsers. Recordings are only made when the teacher starts one, everyone is told, and the file stays on the teacher's computer (nothing is uploaded). Get parents' consent before recording children, as your local rules require.

## License

MIT. See [LICENSE](LICENSE).

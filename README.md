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
- Shared whiteboard with a pen, lines, arrows, rectangles, circles, text, colours and an eraser; undo and redo (`Ctrl+Z` / `Ctrl+Y`) for your own drawings; a "show big" mode; and "Save as image" (PNG)
- Whiteboard background (teacher): put a picture or a PDF worksheet behind the drawings and move through its pages. The PDF is opened in the teacher's browser with [PDF.js](https://mozilla.github.io/pdf.js/); only the current page is shared, and it is forgotten when the class ends.
- Waiting room: students wait until the teacher lets them in. Turn it on for a class when you plan it, or during the class.
- Chat, a big "raise hand" button, and emoji reactions
- Polls and quizzes: the teacher asks a question with 2 to 6 answers (and can mark the right one), sees answers come in live, then shows the results to everyone when ready
- Group work (breakout rooms): split the class into 2 to 8 random groups, move students between groups, and visit any group. Camera, voice and chat stay inside each group; the teacher reads every group's chat and speaks to everyone from the main room. The whiteboard stays shared.
- Class files: the teacher shares worksheets, pictures, slides, sounds or videos (up to 10 MB each, 100 MB per class) from the calendar or during class; anyone with the class code can download them. Files are deleted with the last week of their class.
- Speaking indicator and pinning any video
- Teacher controls: mute one or everyone, lower a hand, remove someone, lock the class, turn the waiting room on or off, lock the whiteboard, clear the board, end the class for everyone
- Attendance list of who joined and when
- Class recording (teacher only): records the class as the teacher sees it, with everyone's voices, and saves an MP4 (or WebM) to the teacher's computer. Everyone sees a red "Recording" badge while it runs. Works in Chrome and Edge on a computer; when Chrome asks, pick the Cartable tab and keep "Also share tab audio" on.
- Keyboard shortcuts: `M` microphone, `V` camera, `H` raise hand

**Class lists, homework and parents**
- Class lists: the teacher adds students (one name per line) and Cartable makes a sign-in code for each student (like `k7pm-w3xa`) and one for a parent (like `p-x4kq9-m2rtw`). Codes are shown once, on printable cards; the teacher can make new ones if a code is lost.
- Classes planned for a class list show up on those students' timetables automatically. In a live class, the teacher sees who signed in with a code and who joined as a guest.
- Homework: give homework to a class list with instructions, files and a due date. Students write an answer and add files or photos, hand in (or take it back) until it is marked. The teacher sees who handed in, late work, and gives a mark and a comment.
- Parent view (read-only): the child's timetable, homework with marks and comments, and the live classes the child joined.

**Timetable and calendar**
- Month calendar with colour-coded classes
- "Today" page with the next class, a countdown, and what to bring
- Weekly repeating classes (up to a whole school year), editable one day at a time or every week at once
- Class reminders: a browser notification 5 minutes before each class while Cartable is open in a tab
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
| Video | WebRTC mesh: each person connects directly to everyone else (or LiveKit, optional) |
| Frontend | Plain HTML, CSS and JavaScript, no build step |
| Storage | SQLite file `data/cartable.db` (teachers, class lists, classes, homework, attendance) and files in `data/files/` |

A mesh works well for a class of about 10–16 people.

### Bigger classes with LiveKit (optional)

For bigger classes, video can go through a [LiveKit](https://livekit.io) server
instead: each browser sends its camera once, and LiveKit passes it on. Set:

| Variable | Example |
| --- | --- |
| `LIVEKIT_URL` | `wss://my-school.livekit.cloud` |
| `LIVEKIT_API_KEY` | from your LiveKit project |
| `LIVEKIT_API_SECRET` | from your LiveKit project |
| `MAX_CLASS_SIZE` | optional, default `50` (max 200) |

Use [LiveKit Cloud](https://cloud.livekit.io) (it has a free tier) or run your
own server. Without these variables Cartable keeps the peer-to-peer mesh and the
16-person limit. With LiveKit, each breakout group is its own LiveKit room, and
Cartable only gives people a token for the room of their group. Removing someone
or ending the class also removes them from LiveKit.

## Tests

```bash
npm test
```

Each test file starts its own Cartable server on a free port with an empty data
folder, and talks to it over HTTP and Socket.IO. GitHub Actions runs the tests on
Node 22 and 24 for every push to `main` and every pull request.

## Good to know

- **Teachers** have their own username and password. Creating an account needs
  the school code (`TEACHER_CODE`). In production, sign-up stays off until you
  set your own code. Each teacher sees and manages only their own classes.
- **Students** sign in with the code from their class list, or join as a guest
  with only a name and a class link. Guests see only the classes they have
  opened, and anyone holding a class link can join, so share links only with the
  class and use **Lock class** or the waiting room once everyone is in.
- **Codes** are stored only as keyed hashes. The key is `CODE_SECRET` (or a
  `secret.key` file Cartable makes in the data folder); if it changes, every
  student and parent code stops working. Wrong codes are slowed down per address.
- Upgrading from 1.1: on first start, `data/db.json` is imported and renamed to
  `db.json.migrated`. Existing classes go to the first teacher who creates an
  account.
- Attendance is deleted after 365 days. Change this with `ATTENDANCE_DAYS`.
- Review your local child privacy rules (GDPR, COPPA) before using Cartable with
  real children.
- Video goes directly between browsers. Recordings are only made when the teacher starts one, everyone is told, and the file stays on the teacher's computer (nothing is uploaded). Get parents' consent before recording children, as your local rules require.

## License

MIT. See [LICENSE](LICENSE).

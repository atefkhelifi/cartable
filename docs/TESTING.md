# Testing a real class

`npm test` checks the server. These checks need real people, real devices and real
networks. Do them on the deployed site (Render), not on `localhost`.

**You need:** 1 teacher on a computer (Chrome or Edge) and 3 students: one Android
phone (Chrome), one iPhone or iPad (Safari), one computer. Ideally one of them on
mobile data or a school network. A teacher account, a class list with the students'
codes, and a class planned for now.

Write down what fails, on which device and network, and what the screen said.

## 1. Joining and video (15 min)

- [ ] Everyone joins with their code. Each person sees and hears everyone else.
- [ ] The student on mobile data or the school network also sees and hears everyone.
      If not, the network blocks direct video: set up a TURN relay (see the README).
- [ ] The teacher shares their screen; students see it big.
- [ ] Mute everyone, lower a hand, remove a student, lock the class: each works.
- [ ] Turn on **Save data** on one phone. That phone only shows the teacher's video
      (students become pictures with initials), and video looks less sharp.
      Turn it off: everyone's video comes back.

## 2. Captions (5 min)

- [ ] The teacher clicks **Captions**, accepts, and speaks in the app's language.
      Students see subtitles within about a second. Try French and Arabic too.
- [ ] Muting the teacher's mic stops the captions. Students can hide them.

## 3. Notifications (10 min)

- [ ] Android: sign in as a student, tap **Notifications**, allow. Close Chrome.
      From the teacher's computer, give homework to the class list: a notification arrives.
- [ ] iPhone/iPad: in Safari, Share, **Add to Home Screen**, open Cartable from the
      home screen, sign in, tap **Notifications**, allow. Give homework: it arrives.
- [ ] Mark that homework in **Marks**: the student (and a parent signed in on another
      device) gets "Homework marked".
- [ ] Plan a class 6 minutes from now for the class list: a reminder arrives about
      5 minutes before. This needs `TZ` set on Render and the server awake.
- [ ] Tapping a notification opens the right page.

## 4. Install (5 min)

- [ ] Android Chrome offers **Install app** (or menu, Add to Home screen). The app
      opens in its own window with the Cartable icon.
- [ ] Computer: Chrome or Edge shows the install icon in the address bar.
- [ ] Turn off the network and open the installed app: the page still opens.

## 5. The rest, quickly

- [ ] Whiteboard: draw on a phone and on the computer; **Add to class files**, then a
      student downloads it from **Files**.
- [ ] Stars in class: the student sees the star and a gold ring on their tile; later
      it shows on their **Today** page and their parent's.
- [ ] Recording (teacher, Chrome on a computer): everyone sees the Recording badge;
      the file plays afterwards.
- [ ] Switch to Arabic on a phone: the layout is right to left and nothing overlaps.

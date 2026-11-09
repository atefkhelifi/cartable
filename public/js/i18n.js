/* Cartable — translations (English is the source language; keys are the English text).
   To add a language: add a dictionary below and a button with data-lang in index.html. */
(() => {
  const NB = ' '; // French puts a non-breaking space before ? ! :
  const fr = {
    // welcome
    'Class is about to start.': 'Le cours va bientôt commencer.',
    "Tell us who you are, and we'll take you to your timetable.": 'Dites-nous qui vous êtes, et nous vous emmenons à votre emploi du temps.',
    'Your name': 'Votre prénom',
    'e.g. Lina': 'ex. Lina',
    'I am a…': 'Je suis…',
    'Student': 'Élève',
    'I join classes': 'Je rejoins les cours',
    'Teacher': 'Enseignant',
    'I plan and lead classes': 'Je prépare et anime les cours',
    'Teacher code': 'Code enseignant',
    'Given by your school': 'Fourni par votre école',
    'Open my timetable': 'Ouvrir mon emploi du temps',
    'That teacher code is not right. Ask your school for it, or join as a student.': "Ce code enseignant n'est pas le bon. Demandez-le à votre école, ou entrez comme élève.",
    'Language': 'Langue',

    // shell
    'Main': 'Principal',
    'Today': "Aujourd'hui",
    'Calendar': 'Calendrier',
    'Switch user': "Changer d'utilisateur",
    'Good morning, {name}': 'Bonjour {name}',
    'Good afternoon, {name}': 'Bon après-midi {name}',
    'Good evening, {name}': 'Bonsoir {name}',
    'Join with a code': 'Rejoindre avec un code',
    'Start a class now': 'Démarrer un cours maintenant',
    "Today's timetable": 'Emploi du temps du jour',
    'Coming up this week': 'Cette semaine',
    'No classes planned yet': 'Aucun cours prévu pour le moment',
    'Plan your first class in the calendar, or start one right now.': 'Planifiez votre premier cours dans le calendrier, ou démarrez-en un maintenant.',
    'When your teacher plans a class, it will show up here.': 'Quand votre enseignant prévoit un cours, il apparaît ici.',
    'Happening now': 'En ce moment',
    'Today at {time}': "Aujourd'hui à {time}",
    '{date} at {time}': '{date} à {time}',
    'Bring:': `À apporter${NB}:`,
    'Starts in {time}': 'Commence dans {time}',
    'You can join 10 minutes before.': 'Vous pourrez entrer 10 minutes avant.',
    '{n} min': '{n} min',
    '{h} h {m} min': '{h} h {m} min',
    '{h} h': '{h} h',
    '{n} day': '{n} jour',
    '{n} days': '{n} jours',
    'Finished': 'Terminé',
    'Join now': 'Rejoindre',
    'Open class': 'Ouvrir le cours',
    'Join': 'Rejoindre',
    'Nothing on the timetable today.': "Rien au programme aujourd'hui.",
    'Nothing else this week.': 'Rien d’autre cette semaine.',

    // calendar
    'Previous month': 'Mois précédent',
    'Next month': 'Mois suivant',
    'Month': 'Mois',
    'Download calendar (.ics)': 'Télécharger le calendrier (.ics)',
    'Plan a class': 'Planifier un cours',
    '{date}, {n} classes': '{date}, {n} cours',
    '+{n} more': '+{n} autres',
    'No classes': 'Aucun cours',
    '1 class': '1 cours',
    '{n} classes': '{n} cours',
    '{start} to {end}': 'de {start} à {end}',
    'With {name}': 'Avec {name}',
    'Copy link': 'Copier le lien',
    'Delete': 'Supprimer',
    'Plan a class on this day': 'Planifier un cours ce jour-là',
    'Invite link copied': "Lien d'invitation copié",
    'Delete every week of this class?\n\nOK: delete all weeks\nCancel: delete only this day': `Supprimer toutes les semaines de ce cours${NB}?\n\nOK${NB}: supprimer toutes les semaines\nAnnuler${NB}: supprimer seulement ce jour`,
    'Class deleted': 'Cours supprimé',
    'Added {n} weekly classes': '{n} cours hebdomadaires ajoutés',
    'Class added to the calendar': 'Cours ajouté au calendrier',
    'Join: {link}': `Rejoindre${NB}: {link}`,

    // course dialog
    'Title': 'Titre',
    'e.g. Fractions with pizza': 'ex. Les fractions avec une pizza',
    'Subject': 'Matière',
    'Maths': 'Mathématiques',
    'Reading': 'Lecture',
    'Writing': 'Écriture',
    'Science': 'Sciences',
    'History': 'Histoire',
    'Geography': 'Géographie',
    'Languages': 'Langues',
    'Art': 'Arts plastiques',
    'Music': 'Musique',
    'Sport': 'Sport',
    'Other': 'Autre',
    'Class / group': 'Classe / groupe',
    'e.g. Year 3 — Blue group': 'ex. CE2 — groupe bleu',
    'Date': 'Date',
    'Starts': 'Début',
    'Ends': 'Fin',
    'Repeat every week for': 'Répéter chaque semaine pendant',
    'Just once': 'Une seule fois',
    '4 weeks': '4 semaines',
    '8 weeks': '8 semaines',
    '12 weeks': '12 semaines',
    'The whole school year': "Toute l'année scolaire",
    'Colour': 'Couleur',
    'What to bring (optional)': 'À apporter (facultatif)',
    'e.g. A pencil, coloured paper and scissors': 'ex. Un crayon, du papier de couleur et des ciseaux',
    'Cancel': 'Annuler',
    'Add to calendar': 'Ajouter au calendrier',
    'Class code': 'Code du cours',
    'Attendance': 'Présences',
    'Done': 'Terminé',

    // classroom
    'Class': 'Cours',
    'Live class': 'Cours en direct',
    'Code {code}': 'Code {code}',
    'Copy invite link': "Copier le lien d'invitation",
    'Locked': 'Verrouillé',
    'Chat': 'Discussion',
    'People': 'Participants',
    'Whiteboard': 'Tableau',
    'Write a message': 'Écrire un message',
    'Message': 'Message',
    'Send': 'Envoyer',
    'Mute everyone': 'Couper tous les micros',
    'Lock class': 'Verrouiller le cours',
    'Unlock class': 'Déverrouiller le cours',
    'Ink': 'Encre',
    'Blue': 'Bleu',
    'Green': 'Vert',
    'Red': 'Rouge',
    'Orange': 'Orange',
    'Eraser': 'Gomme',
    'Brush size': 'Taille du pinceau',
    'Only I can draw': 'Moi seul je dessine',
    'Let everyone draw': 'Tout le monde dessine',
    'Clear': 'Effacer',
    'Show big': 'Agrandir',
    'Back to panel': 'Remettre dans le panneau',
    'Only the teacher can draw right now.': "Seul l'enseignant peut dessiner pour le moment.",
    'Class controls': 'Commandes du cours',
    'Mic': 'Micro',
    'Camera': 'Caméra',
    'Share screen': "Partager l'écran",
    'Raise hand': 'Lever la main',
    'Lower hand': 'Baisser la main',
    'React': 'Réagir',
    'Panel': 'Panneau',
    'Leave': 'Quitter',
    'End for all': 'Terminer pour tous',
    'Ready to join?': `Prêt à rejoindre${NB}?`,
    'Ready for {title}?': `Prêt pour «${NB}{title}${NB}»${NB}?`,
    'No camera found. You can still join with your voice or chat.': 'Aucune caméra trouvée. Vous pouvez quand même participer avec votre voix ou la discussion.',
    'Microphone on': 'Micro activé',
    'Camera on': 'Caméra activée',
    'Not now': 'Pas maintenant',
    'Join class': 'Rejoindre le cours',
    'Pin': 'Épingler',
    'Unpin': 'Désépingler',
    '(you)': '(vous)',
    'You': 'Vous',
    'Microphone off': 'Micro coupé',
    '{name} is sharing their screen': "{name} partage son écran",
    'You joined the class.': 'Vous avez rejoint le cours.',
    '{name} joined.': '{name} est arrivé.',
    '{name} left.': '{name} est parti.',
    '{name} raised their hand ✋': '{name} lève la main ✋',
    '{name} raised their hand': '{name} lève la main',
    'Connection lost. Trying to reconnect…': 'Connexion perdue. Nouvelle tentative…',
    'The teacher muted your microphone': "L'enseignant a coupé votre micro",
    'The teacher lowered your hand': "L'enseignant a baissé votre main",
    'The teacher removed you from the class.': "L'enseignant vous a retiré du cours.",
    'The teacher ended the class. See you next time!': `L'enseignant a terminé le cours. À bientôt${NB}!`,
    'Camera and microphone need a secure (https) connection.': 'La caméra et le micro demandent une connexion sécurisée (https).',
    'No microphone found.': 'Aucun micro trouvé.',
    'No camera found.': 'Aucune caméra trouvée.',
    'Screen sharing is not supported on this device.': "Le partage d'écran n'est pas possible sur cet appareil.",
    'End the class for everyone?': `Terminer le cours pour tout le monde${NB}?`,
    'Remove {name} from the class?': `Retirer {name} du cours${NB}?`,
    'Clear the whiteboard for everyone?': `Effacer le tableau pour tout le monde${NB}?`,
    'Everyone is muted': 'Tous les micros sont coupés',
    'No one has joined yet.': "Personne n'est encore venu.",
    '(Teacher)': '(Enseignant)',
    'muted': 'micro coupé',
    'sharing screen': 'partage son écran',
    'Hand raised': 'Main levée',
    'Mute': 'Couper le micro',
    'Remove': 'Retirer',

    // errors from the server
    'Something went wrong. Try again.': 'Un problème est survenu. Réessayez.',
    'Only teachers can create classes.': 'Seuls les enseignants peuvent créer des cours.',
    'Add a title, a date, a start time and an end time.': 'Ajoutez un titre, une date, une heure de début et une heure de fin.',
    'The class must end after it starts.': 'Le cours doit finir après avoir commencé.',
    'Only teachers can delete classes.': 'Seuls les enseignants peuvent supprimer des cours.',
    'Class not found.': 'Cours introuvable.',
    'Only teachers can see attendance.': 'Seuls les enseignants peuvent voir les présences.',
    'This class link is not valid.': "Ce lien de cours n'est pas valide.",
    'The teacher has locked this class. Ask them to unlock it.': "L'enseignant a verrouillé ce cours. Demandez-lui de le déverrouiller.",
    'This class is full (16 people max).': 'Ce cours est complet (16 personnes maximum).',
  };

  const DICTS = { fr };
  const SUPPORTED = ['en', 'fr'];
  const read = () => { try { return localStorage.getItem('cartable.lang'); } catch { return null; } };
  let lang = read() || ((navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en');
  if (!SUPPORTED.includes(lang)) lang = 'en';

  const t = (key, vars) => {
    let s = (DICTS[lang] && DICTS[lang][key]) || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  };

  // Translate static markup. Originals are remembered so switching back works.
  const origText = new WeakMap();
  const ATTRS = ['placeholder', 'aria-label', 'title'];
  function apply(root = document.body) {
    document.documentElement.lang = lang;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('script, style, [data-no-i18n]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const raw = n.nodeValue;
      const key = origText.has(n) ? origText.get(n) : raw.trim();
      if (!key || !(key in fr)) continue;
      origText.set(n, key);
      const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
      n.nodeValue = lead + t(key) + trail;
    }
    root.querySelectorAll('[placeholder], [aria-label], [title]').forEach((el) => {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const store = `data-i18n-${a}`;
        const key = el.getAttribute(store) || el.getAttribute(a);
        if (!(key in fr)) continue;
        el.setAttribute(store, key);
        el.setAttribute(a, t(key));
      }
    });
    document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  }

  function setLang(l) {
    if (!SUPPORTED.includes(l) || l === lang) return;
    lang = l;
    try { localStorage.setItem('cartable.lang', l); } catch {}
    apply();
    window.dispatchEvent(new Event('languagechange-app'));
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
  });

  window.I18N = { t, apply, setLang, get lang() { return lang; }, locale: () => (lang === 'fr' ? 'fr-FR' : (navigator.language?.startsWith('en') ? navigator.language : 'en-GB')) };
  document.addEventListener('DOMContentLoaded', () => apply());
})();

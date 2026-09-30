# Werewolf Moderator

A phone-friendly, self-hosted digital moderator for the party game **Werewolf**
(a.k.a. Mafia) — built for playing **online, from separate homes**, with no
one sitting out as "the host." Someone starts a lobby, everyone else joins
from their own phone or laptop browser, and the app runs the whole game:
role assignment, night phases, a live in-app sheriff campaign, speech order,
day voting, and a full recap at the end.

It has **zero dependencies** — just plain Node.js, nothing to `npm install`.
That was a deliberate choice to make it as painless as possible to deploy
without a real dev environment.

## Tests

`npm test` runs the full integration suite (real HTTP calls against a real
server it starts itself, no mocking) in under a minute. See
[`tests/README.md`](tests/README.md) for how it works and how to add to it.

## No host — everyone is a player

There is no separate "moderator" screen and no one who can see more than
they should. Whoever starts the lobby is just the **lobby leader**: they get
a couple of extra pre-game controls (configuring roles, timers, and win
condition, starting the game, removing a player who dropped out), but their
game screen shows exactly what anyone else's does. No client — leader or
not — ever sees another player's role, another player's private night
action, or the game log before it's been announced to everyone. If you
wanted an "invisible" screen to watch everything, that's gone on purpose —
it's not something the game needs anymore.

## Wolves know their pack

The one deliberate exception to "no one sees more than they should": every
Werewolf (and the Werewolf King) can see who their fellow wolves are, for
the entire game — not just during their shared night kill vote — same as
in the physical game, where the wolves quietly know each other from the
start. On a wolf's screen, teammates are marked with a small 🐺 next to
their name in the seating order list that's always on screen; no other
player ever sees that marker, on anyone.

The **Hidden Wolf** (see **Roles** below) is the one exception to that
exception: they don't know who the other wolves are, and the other wolves
don't know about them either — the concealment runs both ways, so this
marker never appears for or about a Hidden Wolf.

## Small quality-of-life touches

- **Every player's role card, with its full ability description, stays on
  screen for the whole game** once revealed — no one has to remember what
  their role does from a single glance at the start.
- **The Seer's nightly result is never lost.** It shows as a small banner
  right under their role card for the rest of that night and the following
  day (not just for an instant right after they check someone), and it's
  served from the game state itself rather than a one-off response, so it
  survives a page reload or a phone locking and reopening the tab.
- **A phase-change sound cue** plays a short chime whenever the game moves
  forward (a new phase, a new night sub-phase, a new speaker) — a small
  🔔/🔕 toggle next to the room code lets each player mute it for themselves.
- **When it's specifically YOUR speech turn**, the "Now speaking" card pulses
  with its own color and a distinct two-note chime (plus a short vibration on
  phones that support it) — separate from the general phase-change chime, so
  you don't have to be staring at the screen to notice it's your turn.
- **Pixel-art avatars.** Everyone gets a little 8-bit critter when they join
  (lots of body shapes, eyes, mouths, hats, patterns and colors, all drawn
  in code, so no image downloads). Tap 🎲 Shuffle in the lobby until you like
  yours; it locks when the game starts. Avatars are purely cosmetic: they
  never show a wolf, crown, badge, ghost or skull, and in the seating list
  everything that matters (Sheriff, your wolf packmates, revealed roles, no
  vote, who's speaking) sits in tags on the right, apart from the avatar.
  A dead player's avatar just goes grey.
- **Big moments stop the table.** When the Hunter fires, the Knight duels,
  the Werewolf King reveals himself, the Sheriff badge changes hands, or dawn
  breaks, every phone shows a center-screen popup (with its own low "boom"
  sound and a buzz) saying exactly what happened and who did it. Tap to
  close, or it clears itself after a few seconds; back-to-back moments queue
  up one after another instead of overlapping.
- **Discussion pauses during a duel or reveal.** While someone gives last
  words after a Knight's duel or the Werewolf King's reveal, the current
  speaker's clock is frozen (shown as "⏸️ Discussion paused") and they get a
  fresh full turn afterward, instead of silently timing out underneath.
- **A vote result toast.** The instant the day elimination vote or the
  Sheriff election resolves, a bold banner slides in announcing the outcome
  and fades out on its own a few seconds later — no need to squint at the log.
- **The final vote is revealed — like everyone pointing at once in person.**
  Once a vote is fully locked in, a "who voted for whom" card shows exactly
  that (including anyone who abstained), and stays up for reference. This is
  deliberately different from *during* the vote, where no running tally is
  shown at all (see below) — the reveal only happens after the fact.
- **Abstain is a real, active choice**, not just "let the timer run out": a
  dedicated Abstain button on both the day vote and the Sheriff election
  locks in "I'm not voting" immediately. Once every eligible voter has either
  voted or abstained, the vote concludes right away instead of the whole
  table waiting out the clock for one holdout.
- **The Hunter and the Knight always reveal themselves the instant they act**
  (firing a shot / dueling), independent of the "reveal role on death"
  setting — the same way the Werewolf King already did. A Hunter's (or the
  Werewolf King's) target's own role still only follows that setting, and a Knight's wrongly-accused
  duel target stays fully hidden (only "innocent" is proven, not their exact
  role) — only a duel that actually catches a werewolf reveals the target.
- **Anyone who dies during the day** — executed by vote, shot by the Hunter,
  or on either end of a Knight's duel — gets one final "last words" speech
  turn before the game moves on, just like the table would let them speak
  before being led away in person. A night death normally doesn't get this
  (it's only discovered, never explained, the next morning), with one house
  rule: **whoever dies on the first night gets last words** on the morning
  of Day 1, so nobody is knocked out before saying a single word.
- **A tied day vote or Sheriff election isn't a coin flip.** The tied players
  get one more speech turn, then the village votes again among just them —
  see "House-rule choices" below for what happens if that runoff ties too.
- **A "Leave this game" button** (🚪, next to the room code) clears your
  saved session and returns you to the main menu, so you can back out of a
  game without clearing your browser's cookies/site data. Opening a fresh
  invite link for a different room also now correctly starts a new game
  instead of silently reconnecting you to whatever room you were in before.

## Playing online — quick rundown

1. One person opens the app, taps **Create a Game**, and enters their name.
   They get a 4-letter room code and become the lobby leader.
2. Everyone else opens the same link (or the app + the code) and taps
   **Join a Game**, entering their own name.
3. The leader sets how many of each role to use (must equal the number of
   players who've joined), picks a win condition, and can tune every timer
   (see **Timers** below) — then taps **Start Game**.
4. Every player reveals their own role privately. Night 1 resolves in the
   background — nothing is announced yet.
5. Day 1 opens directly into the **Sheriff campaign** (see below), before
   anyone learns what happened overnight. Once that concludes, the night's
   events are announced (deaths only — never *how* anyone died) and normal
   day discussion begins, following the seating order's speech rules.
6. After discussion, a short countdown leads into the elimination vote.
   Repeat night → campaign-only-on-day-1 → discussion → vote until someone
   wins, then everyone sees the full recap.

Nobody has to remember rules, enforce turn order, or keep a game log —
the app does all of it, and does it the same way for every player.

## The Sheriff campaign ("day 0")

Before anything about the night is revealed — before deaths, before
anyone even learns whether *they themselves* are still alive — Day 1 opens
into a live campaign round:

1. **Nominate** — any player can tap to run for Sheriff during a short
   window (the `candidacy` timer).
2. **Speeches** — if two or more players are running, each candidate gets
   a turn to make their case (the `speech` timer per turn). With zero or
   one candidate, this step is skipped.
3. **Vote** — everyone votes for a candidate (the `electionVote` timer).
   Highest vote count wins the badge. A tie triggers a **runoff**: the tied
   candidates each get one more speech turn, then the village votes again
   among just them. If that runoff ties too, there's no Sheriff this game —
   no coin flip, no third round.

This round is deliberately separate from the rest of the day — it's
sometimes called "day 0." Since no one's death has been announced yet, a
secretly-dead player can fully run, give a speech, vote, and even win the
badge, without anyone (including themselves, on their own screen) knowing
they didn't survive the night. That's not a bug — it's real information for
the table: winning the badge and then immediately turning out to be dead
says something. It also gives villagers with no night power something
concrete to do and read into on day 1.

The instant the campaign ends, the night is revealed. If the newly-elected
Sheriff turns out to be dead, *they* (not anyone else) are immediately
prompted to pass the badge to someone else or retire it, before discussion
starts.

## Speech order

Once the night is revealed, the day's discussion follows the seating
circle (a random seat order fixed once at game start) in one of these
ways:

- **Exactly one player died** last night: whoever sits next to the
  deceased starts. If there's a Sheriff, the Sheriff chooses which side —
  left or right — starts (which also sets the direction the rest of the
  table speaks in). With no Sheriff, the app picks the side at random.
- **Nobody died, or two or more died**, and there **is** a Sheriff: the
  Sheriff always speaks last, and chooses which neighbor starts (and thus
  the direction).
- **Nobody died, or two or more died**, and there's **no** Sheriff: the
  app picks a random starting player and a random direction.

The current speaker is highlighted on every player's screen, along with an
explicit ⬆️/⬇️ arrow (in the roster header and on the "Now speaking" card)
showing which way the order is walking the seat list — down and wrapping
from the bottom back to the top, or up and wrapping from the top back to
the bottom — so no one has to infer direction from watching the highlight
move. They can tap "I'm done speaking" to pass to the next player
immediately, or just let their turn run out (the `speech` timer, tunable
in the lobby) — either way the game advances itself, no manual "force
advance" anywhere. Once everyone's had a turn, a short fixed 10-second
countdown leads into voting.

**Knight and Werewolf King** are the one exception: their one-time ability
can be used **at any point** during this regular discussion — even
interrupting whoever's currently speaking — since using it can end the
day's discussion outright and timing it is a real strategic choice. (This
does *not* apply during the Sheriff campaign, which is a separate, earlier
round.)

## Nothing waits on a manual override

Every point in the game that used to need a human moderator to step in —
casting a night action, voting in the campaign or the day vote, deciding
whether to speak longer — instead has its own **tunable timer**, shown as a
live countdown on the relevant players' screens. If time runs out, the game
auto-advances with a sensible default (no vote cast, no ability used, pass
the turn) so nobody can accidentally hold up the table. There is no "force
advance" button anywhere, for anyone.

### Timers (all configurable in the lobby before starting)

| Timer | Governs |
|---|---|
| `candidacy` | How long the Sheriff-campaign nomination window stays open. |
| `electionVote` | How long the Sheriff-campaign vote stays open. |
| `speech` | The max length of a single discussion turn before it auto-passes. |
| `dayVote` | How long the day's elimination vote stays open (kept separate from — and usually shorter than — the campaign vote, since by then people already have a read on the table). |
| `nightAction` | Every night sub-phase (Guard, wolves, Seer, Witch in turn), plus the Hunter's revenge shot, a Sheriff handoff, and a Sheriff's speech-order pick. Night actions are **sequenced**, not run on one shared clock — the Witch's window doesn't open, for instance, until the wolves have actually acted, since she needs to see their target first. |

## Night deaths are never explained

The morning announcement only ever says *who* died — never *how*. Figuring
out whether someone was wolfed, or protected-but-still-gone, or anything
else, is left entirely to the table to reason about; that ambiguity is part
of the strategy. The two exceptions are the **Knight's duel** and the
**Werewolf King's reveal**, which are voluntary, public, self-reveals (not
hidden night mechanisms) — when either is used, the full outcome is
announced in detail: who used it, on whom, and what happened. (The person
on the receiving end only has their role shown if they're a wolf caught by
the Knight, or if "reveal role on death" is turned on.)

## End-of-game recap

When the game ends, every player sees a full recap: every announcement
from every day of the game, in order, plus every player's true role and
final fate. It's a replay of the same story everyone already lived through
— outcomes only (who died, who was elected, who won a duel, who the
village voted out), not a play-by-play. It deliberately leaves out routine
process noise (individual "so-and-so cast their vote" lines) and the
secret per-night mechanics that were never announced in the first place
(exactly who the Guard protected, who the Seer looked at, who the Witch
targeted) — the "night deaths are never explained" rule holds at the
recap too, just with final roles and the win/loss now attached.

## Roles

| Role | Side | Power |
|---|---|---|
| Werewolf | Wolf | Votes with the pack each night to choose a victim. |
| Werewolf King | Wolf | Votes with the pack like a normal wolf. Once per game, at any point during day discussion (even interrupting the current speaker), may reveal himself and choose a player — both die immediately, publicly and in full detail. |
| Hidden Wolf | Wolf | A wolf who doesn't wake with the pack and doesn't know who the other wolves are — and they don't know about him either. Has no kill of his own until every other wolf has died; once he's the last wolf standing, he wakes alone each night and chooses the kill by himself. A Seer checking him learns he's Village-aligned; a Knight's duel is not fooled and correctly reveals him as a wolf. Capped at one per game. |
| Villager | Village | No power. Plain vote. |
| Seer | Village (God) | Each night, learns whether one chosen player is Werewolf-team or Village-team. |
| Witch | Village (God) | Sees the wolves' victim (only while she still holds her heal potion) and has one heal + one poison, each usable once per game. |
| Hunter | Village (God) | If killed by anything except the Witch's poison, immediately fires back and eliminates one more player. |
| Fool | Village (God) | Plays like a normal villager. If voted out by the town, does **not** die — instead is revealed to everyone and permanently loses the right to vote. |
| Guard | Village (God) | Each night, protects one player from the wolves' kill. Can't protect the same player two nights running. |
| Knight | Village (God) | Once per game, at any point during day discussion (even interrupting the current speaker), may reveal himself and duel another player. If the target is a Werewolf, the wolf dies and the game jumps straight to night — publicly announced in full. If the target is Village-aligned, the Knight dies of shame instead and the day continues normally. |

"God" here just means a special (non-Werewolf, non-plain-Villager) village
role — it's the label your group already uses; it only affects gameplay
under the **Extinction** win condition, where wiping out all Gods (or all
plain Villagers) wins it for the wolves.

Every role except Werewolf, Villager and Hunter is capped at **1 per game** (multiple Hunters is a fun variant: each one gets their own shot, and a Hunter shot by another Hunter fires back too) in the
lobby's role setup — these are the roles whose one-time abilities and
night-action state (the Witch's potions, in particular) are only tracked
once per game, not once per player, so a second copy of any of them isn't
supported. The config UI won't let you enter more than 1, and the server
clamps it even if it somehow got past that.

Two selectable **win conditions**, toggled by the lobby leader before
starting:

- **Majority** (the original rule): Village wins when all wolves are dead;
  Werewolves win once they equal or outnumber the remaining village.
- **Extinction** (Chinese werewolf / 屠边 "sweep a side" rules): Werewolves
  win the instant *either* all Gods are dead *or* all plain Villagers are
  dead — whichever side gets wiped out first, regardless of headcount.
  Village still wins whenever all wolves die.

## House-rule choices I made

The game has a lot of table-to-table variation, so I had to pick some
defaults. All are easy to change — just say so and I'll adjust the code:

- **The wolves' night kill vote** breaks a tie by random pick among the tied
  targets — it's a hidden vote with no discussion possible in the moment, so
  a runoff isn't practical there the way it is during the day.
- **The day elimination vote and the Sheriff election** do NOT break ties at
  random. A tie triggers one **runoff**: the tied players get one more
  speech turn, then everyone votes again among just them. A second tie in
  that runoff means nothing happens — no one is eliminated / there's no
  Sheriff this game — rather than a third round or a coin flip.
- **Reveal role on death** defaults to **off**: a dead player's role stays
  secret until the game ends, since knowing everyone's role as they die
  flattens a lot of strategic play. A lobby toggle turns it on. Either way,
  a player who publicly *uses* an ability (Hunter firing, Knight dueling,
  Werewolf King revealing, Fool surviving a vote) outs themselves; the people
  they hit don't.
- The **Witch** can target herself with either potion, and can poison any
  living player (not just the wolves' victim).
- **Wolves can vote to kill a fellow wolf** — a real, occasionally-used
  strategy (throwing suspicion elsewhere, cutting loose a packmate whose
  play is putting the team at risk) — and **a wolf can vote to kill
  themselves** (a "self-kill", e.g. to bait the Witch into using her heal, or
  to look like an innocent victim the next morning). Voting for yourself is
  only allowed there: never in the day vote or the Sheriff election.
- **The wolf pack sees each other's picks live** during the kill vote — a
  running "who's voting for whom" line, plus a 🐺 tag under each candidate
  showing which packmates currently favor it — and can change their vote
  freely, the same way real wolves gesture at the table to converge on a
  target. The phase only closes early once the whole active pack agrees on
  the same target; if they're still split when the timer runs out, it
  resolves as a majority vote with a random tie-break, same as always.
- Not voting, not using a night ability, and not ending your speech turn
  early are all fine — every one of those has its own timer and a defined
  no-op outcome if time runs out.
- **The Day-1 Sheriff campaign always runs first, completely undisturbed** —
  nothing from night 1 is acted on before it, not even a Hunter's own death
  and revenge shot. If the wolves kill the Hunter on night 1, their shot
  stays queued and only becomes available once the campaign has fully
  concluded; it's never fired (by them or by a timeout) beforehand.
- **Candidates don't get a vote in their own Sheriff election** — only
  non-candidates vote, and the "everyone's voted" fast-forward only counts
  those eligible voters.
- **No running tally is ever shown while a vote is still open** (day vote or
  Sheriff election) — no live counts, no partial "who's voted for whom" —
  specifically to prevent bandwagoning onto whoever's already ahead. Once the
  vote is fully locked in, the full "who voted for whom" reveal (including
  abstains) is shown — the same way an in-person table sees everyone point at
  once, just never mid-count.
- **Abstain counts toward "everyone's acted"** the same as a real vote does —
  it just doesn't count toward anyone's tally — so one player choosing to
  abstain doesn't force the rest of the table to sit out the full timer.
- **A live day-vote tally is never shown while voting is still open** — you
  can see your own pick and how many people have voted so far, but not the
  breakdown, so no one can bandwagon onto whoever's currently ahead.
- If the sitting **Sheriff dies**, it's the dying Sheriff themselves — not
  anyone else — who's prompted (once the death is revealed) to hand the
  badge to someone else or retire it for the rest of the game.
- If the **Hunter** dies the same night the wolves *and* the witch's poison
  both land on him, it counts as a poison death (no revenge shot) — poison
  always "wins" for this purpose.
- If the Hunter's revenge shot could change the outcome (e.g. he takes a
  wolf down with him), the game waits for that shot to resolve before
  declaring a winner — including when it's the Werewolf King's reveal, or
  Extinction rules, that would otherwise end the game that instant.
- The **Guard** may protect themselves, and is only blocked from repeating
  *last* night's specific target — anyone else, including a target from two
  or more nights ago, is fair game again.
- The **Knight**'s duel and the **Werewolf King**'s reveal are usable at any
  point during regular day discussion (not during the Sheriff campaign, and
  not once voting has opened). Each is strictly one-time-per-game.
- A **Fool** who is voted out is marked publicly revealed (their card shows
  to everyone from then on) and loses their vote for the rest of the game,
  but stays alive and can still be targeted at night like anyone else. If
  they were holding the Sheriff badge, the same hand-off prompt used on a
  Sheriff's death fires immediately — the Fool can no longer vote, so the
  badge doesn't stay with them by default; they choose who gets it (or let
  it lapse) exactly like a dying Sheriff would.
- The **Hidden Wolf**'s concealment only fools the Seer's magic. A Knight's
  duel is a direct physical confrontation, not detection, so it correctly
  reveals a Hidden Wolf as a wolf like any other. Capped at one per game,
  same as the other unique roles.

## Deploying it (recommended: Render, free, no install needed)

Render's free tier needs no credit card and no command line — everything
happens through GitHub.com and Render.com in your browser.

**1. Put the project on GitHub (no git required on your computer):**
   - Go to [github.com](https://github.com) and create a free account if you
     don't have one.
   - Click **New repository**, name it something like `werewolf-moderator`,
     and create it (it can be public or private).
   - On the empty repo page, click **uploading an existing file** and drag
     in `server.js`, `package.json`, and `README.md` from this project, then
     commit.
   - Then click **Add file → Create new file**, and for the filename type
     `public/index.html` (typing the `public/` prefix creates that folder
     automatically). Paste in the contents of this project's
     `public/index.html`, and commit.

**2. Deploy it on Render:**
   - Go to [render.com](https://render.com) and sign up free.
   - Click **New +** → **Web Service**, and connect the GitHub repo you just
     made.
   - Render auto-detects Node.js. Leave the build command as-is (or blank —
     there's nothing to install) and set the start command to `node
     server.js` if it isn't already.
   - Click **Create Web Service**. After a minute or two you'll get a public
     URL like `https://werewolf-moderator.onrender.com` — that's the link
     everyone opens, from wherever they are.

**Heads up on the free tier:** it spins down after ~15 minutes with no
traffic, and takes about a minute to wake back up. That only matters
*between* game nights — while people are actually playing, their browsers
are polling the app several times a second, so it stays awake for the whole
game. Just open the link yourself once before everyone joins, so it's
already warm.

## Running it locally instead

If everyone happens to be on the same WiFi (e.g. one shared house), you can
skip hosting it entirely:

```
node server.js
```

Then find that computer's local IP address (on Mac: System Settings → WiFi
→ Details; on Windows: `ipconfig`) and have players open
`http://<that-ip>:3000` on their own device. If the app doesn't load, check
that the computer's firewall allows incoming connections on port 3000.
This won't work for players in separate homes — for that, use the Render
deployment above.

## Limitations to know about

- **Games live in memory only.** If the server restarts (a redeploy, or the
  free-tier host recycling the process), any game in progress is lost —
  players would need to rejoin and start over. Fine for a casual game night,
  not meant for anything you can't afford to redo.
- Updates are pulled by each browser polling about once a second rather
  than a live push connection — deliberately simple and dependency-free,
  and the lag is imperceptible for a turn-based game like this.
- No accounts or persistence between sessions — closing the tab keeps your
  spot (there's a reconnect token saved on your device) as long as the game
  is still running, but there's no history once it ends.

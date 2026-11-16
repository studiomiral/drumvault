// Vocals (SCOPE.md §6.11): the bank of lines a vocal take sings, original, written for this app:
// club chants of two to six words and longer sung phrases of seven to twelve, made to repeat (no
// verses, no choruses). A take sings one to three of them; the Vocals page can change them before
// it's made.

export const LYRICS: string[] = [
  // the night, the room
  'Into the night we go', 'Lights down low', 'Under the strobe', 'Late night feeling', 'Stay till the morning',
  'Night keeps calling', 'All night long we move', 'The room is breathing', 'Lost in the haze', 'Midnight on my mind',
  // moving
  'Move your body slow', 'Keep on moving', 'Don’t stop now', 'Feel it in your feet', 'Let your body talk',
  'Sway with me', 'Rise and fall', 'Step into the light', 'Ride the rhythm', 'Turn around',
  // feeling
  'I can feel it', 'Something in the heat', 'Deep inside me', 'Hold that feeling', 'Can you feel me',
  'Feel the pressure', 'Heart beats faster', 'Give me more', 'Up and up we go', 'Taking me higher',
  // together
  'You and me', 'Come a little closer', 'Stay with me tonight', 'Hold on to me', 'Just us two',
  'We belong here', 'Together we rise', 'Don’t let me go', 'Call my name', 'Right here with you',
  // light, sky, water
  'Golden light', 'Neon on your skin', 'Chasing the sun', 'Like a wave', 'Falling stars',
  'Burning slow', 'Glow in the dark', 'Colours in the sky', 'Ocean in my head', 'Fire on the floor',
  // calls, chants
  'Oh oh oh', 'Hey hey', 'Come on', 'Say yeah', 'Here we go',
  'Let it go', 'Once again with me', 'Do it again', 'Never enough', 'Right now',
  // mood
  'Set me free', 'Breathe it in', 'Let the music lead', 'Lose control', 'No more waiting',
  'This is our time', 'Nothing can stop us', 'Clear your head', 'Open up your heart', 'Warm inside tonight',
]

/** Longer phrases (a bar or two each, sung): one alone, or answered by a chant, or two of them. */
export const PHRASES: string[] = [
  'When the lights go down I can feel you move with me', 'Every time the music plays I come alive again',
  'Take me to the place where the night never ends', 'I been waiting all my life for a feeling like this',
  'Hold me close and let the rhythm carry us away', 'Nothing in this world can take this love from me',
  'Lift your hands up high and let the spirit move you', 'Deep down in my soul I know we’re gonna be alright',
  'You light me up like the morning sun', 'Close your eyes and let the music set you free',
  'I can hear you calling from across the floor', 'We don’t need nobody when the beat is this strong',
  'All my worries fade away when I’m dancing next to you', 'Let the bassline take you higher than you’ve ever been',
  'There’s a fire in my heart that only you can feel', 'Come on and give me something I can believe in',
  'Underneath the city lights we found our way', 'I keep coming back to you like the tide',
  'Your love is like a river running through me', 'We were made to move together through the night',
  'Raise your voice and sing it like you mean it', 'I feel the power of the music in my bones',
  'Don’t you ever let the feeling fade away', 'Somewhere in the sound I found my way back home',
  'You got that kind of love that keeps me dancing', 'Brighter than the stars that shine above us',
  'Dim the lights and let the music play all night', 'Every heartbeat brings me closer to you',
  'Lay your burdens down and come and dance with me', 'I was lost until the rhythm found me',
  'Hold on tight we’re going all the way tonight', 'Let it rain down on me, let it wash me clean',
  'I’ll be right beside you when the morning comes', 'Feel the light come shining through the dark',
  'Sweet release when the drums begin to roll', 'Can’t nobody stop us when we move as one',
]

/** `n` different lines of `bank` (the chants by default), by `random` (0…1), for a take to repeat. */
export function pickLines(n: number, random: () => number = Math.random, bank: string[] = LYRICS): string[] {
  const pool = [...bank]
  const out: string[] = []
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
  return out
}

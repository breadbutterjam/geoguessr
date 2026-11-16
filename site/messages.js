/* ==========================================================================
   messages.js: the lines shown after each guess. Edit freely.

   bands: the game takes the first band (top to bottom) whose "min" is at or below the
          guess's score as a fraction of the maximum (1 = perfect, 0 = nothing), then
          shows one of its lines at random (never the same line twice in a row).
   noGuess: shown when time ran out with no pin placed.
   Use {distance} in a line to insert the distance, e.g. "340 m".
   ========================================================================== */
window.GAME_MESSAGES = {
  bands: [
    { min: 0.98, lines: [
      'Wow, that was so close. Are you sure you are not already standing there?',
      'Basically on the spot. Do you live on this street?',
      'Pinpoint. Street View should hire you.',
      'Only {distance} off. That is not a guess, that is memory.',
    ] },
    { min: 0.90, lines: [
      'So close. You know this neighbourhood.',
      'Very nearly. Just {distance} away.',
      'Sharp eyes. You could walk it from there.',
      'Almost a bullseye. Well played.',
    ] },
    { min: 0.70, lines: [
      'Good guess. You are in the right area.',
      'Nicely done. A short walk from the truth.',
      'You read the street well. {distance} off.',
    ] },
    { min: 0.40, lines: [
      'Not bad. The right part of town, give or take.',
      'Warm, but not quite. Look at the signboards next time.',
      'Close enough to wave at it from there.',
    ] },
    { min: 0.10, lines: [
      'Hmm. That is a fair distance away.',
      'Wrong end of the neighbourhood. Check the road widths and the shopfronts.',
      'You were thinking of a different gali, I think.',
    ] },
    { min: 0, lines: [
      'Are you even in the same city?',
      'That was... somewhere else entirely.',
      'Did you pick a pin with your eyes closed?',
      '{distance} away. A local train ride, at least.',
    ] },
  ],
  noGuess: [
    'Time ran out. The street keeps its secrets.',
    'No pin this time. Even a rough guess beats none.',
  ],
};

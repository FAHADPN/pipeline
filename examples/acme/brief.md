# Acme Coffee

## About

Acme Coffee is a small neighbourhood roaster with one café and an online shop. It sells single-origin beans, a house espresso blend and a monthly subscription box.

## Audience

People aged 22 to 40 who make coffee at home, follow a few café accounts and want to get a little better at it without gear talk. They watch Reels on the way to work and in the evening.

## What to make

Short vertical Reels, 15 to 30 seconds, faceless:

- **Story** pieces: a small, recognisable coffee moment with a twist at the end.
- **This or that**: two choices on screen, the viewer picks in the comments.
- **How many**: a checklist the viewer counts against their own habits.

Every piece ends on the Acme mark and `acme.coffee` for one second.

## How to build the video

Build each piece as a HyperFrames project in the piece folder (`npx hyperframes`), 1080×1920 at 30 fps. Use the bundled fonts only.

- **Voice:** use the `media-use` skill's text-to-speech with the voice and style in `voice.md`. Use Gemini if `GEMINI_API_KEY` is set, and Kokoro otherwise.
- **Music:** a light acoustic bed under the voice, at about 0.14 volume.
- **Captions:** burned in.

Render with `npx hyperframes render -q delivery -o out/<name>.mp4`, then export the cover from the strongest frame.

## Never

- No prices, discounts or "limited time" language.
- No health claims about caffeine.
- No other brands, cafés or real people by name.
- No coffee-snob gatekeeping: never make the viewer feel wrong for liking milk and sugar.

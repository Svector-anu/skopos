# Social cards

Weekly **"shipped this week at skopos"** product-update graphic (1920×1080), in brand:
black + `#F5B800`, JetBrains Mono terminal, Source Sans headline. The right-hand
terminal shows a real product output, so the card doubles as branding and a live demo.

## Regenerate

1. Edit `shipped-card.html`:
   - the **date** pill (`Jun 27 – Jul 3`)
   - the terminal `.body` block — swap in the week's headline shipment (a smart-money
     intel read, live stock prices, a swap quote…). Keep the numbers real.
2. Run `./render.sh` (needs Google Chrome). Output: `shipped-card.png`.
   Or pass a path: `./render.sh ~/Desktop/skopos-shipped-jul10.png`.

## Which demo to lead with

Lead with **smart-money intel** — it's the most differentiated feature and the named
wallets (e.g. Wintermute) land instantly. Stock prices and market reads make good
*secondary* cards in a thread.

## Notes

- Fonts load from Google Fonts at render time, so the render needs network access.
- The card is pure HTML/CSS — no build step, no dependencies.

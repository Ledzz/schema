# Circuit recipes

Proven building blocks with values and the reason behind each. LCSC numbers are examples that
were Basic and in stock when written; confirm with `search_parts` / `get_part_details` because
stock and Basic status change.

Contents: decoupling · linear regulators · USB-C power · connectors · indicator LED · I2C ·
buttons · reset/enable · crystals · 555 timer · MCU minimum systems

## Decoupling

- 100 nF ceramic (X7R, 0402/0603) on **every** IC power pin, placed next to that pin on the PCB.
  It supplies the fast current spikes the rail's long path cannot.
- 1–10 µF bulk capacitor per rail or per larger IC.
- Analog supplies (VDDA, AVCC): 1 µF + 10 nF, optionally fed through a ferrite bead from the
  digital rail to keep switching noise out.

## Linear regulators

| Part | LCSC | Current | Package | Caps | Notes |
|---|---|---|---|---|---|
| AMS1117-3.3 | C6186 | 1 A | SOT-223 | 10 µF in, 22 µF out | ~1.1 V dropout, so needs ≥4.5 V in (fine from USB 5 V). Pins: 1 GND, 2 VOUT, 3 VIN, tab = VOUT. The datasheet asks for ≥22 µF on the output for stability. |
| XC6206P332MR | C5446 | 200 mA | SOT-23 | 1 µF in and out | Low quiescent current; too small for Wi-Fi modules. |
| ME6211C33M5G-N | C82942 | 500 mA | SOT-23-5 | 1 µF in and out | Low dropout; CE (enable) tied to VIN. |

Pick by peak current: Wi-Fi/BLE modules draw 300–500 mA peaks, so they need the 1 A class.

## USB-C power (5 V sink, no data)

- VBUS pins → `+5V`; GND pins → `GND`.
- CC1 and CC2 each to GND through **its own** 5.1 kΩ resistor. The resistors tell the source to
  supply 5 V; one shared resistor or none at all means C-to-C cables deliver nothing.
- Shell/shield → GND (or through 1 MΩ ∥ 4.7 nF if you want it isolated).
- For USB 2.0 data, connect the matching pairs together (A6+B6 = D+, A7+B7 = D−) and route them
  to the MCU; add an ESD diode array (e.g. USBLC6-2SC6) on D+/D− for anything handled by people.
- Put 10 µF on `+5V` near the connector.

## Connectors

There are practically no basic or preferred connectors, so plan on the $3 fee per unique
connector. Through-hole connectors also cost extra to assemble at JLCPCB; offer to leave them out
of the assembly order so the user can hand-solder them.

| Need | Search for | Example (extended) |
|---|---|---|
| USB-C, power only | `Type-C 6P` | TYPE-C 6P, C456012 (VBUS, GND, CC1, CC2) |
| USB-C with USB 2.0 data | `Type-C 16P` | pick a mid-mount SMD part with high stock |
| 2.54 mm pin header | `2.54mm header 1x4` (any count) | PZ254V-11-02P (1×2), C492401 |

"USB-C" and "pin header" as keywords mostly return nothing or unrelated parts.

## Indicator LED

R = (V_drive − V_f) / I. Indicators need only 1–5 mA.

- Red/yellow/orange: V_f ≈ 2.0 V → 1 kΩ on 3.3 V (≈1.3 mA) or on 5 V (≈3 mA).
- Green/blue/white: V_f ≈ 2.6–3.2 V. On 3.3 V that leaves almost no headroom, so feed them from
  5 V when it exists (1 kΩ ≈ 2 mA); otherwise 100 Ω on 3.3 V.
- Driven from an IC output, use the output's real high level, not the supply: a bipolar NE555
  gives about V_cc − 1.7 V; CMOS outputs (MCUs, TLC555) come close to the rail.
- Wire LEDs by pin name: `D1.A` (anode) and `D1.K` (cathode). The app's generic LED has
  1 = K and 2 = A, but library LED symbols often number them the other way round.
- Basic LEDs that were in stock: red 0603 C2286, green 0805 C2297 (there is no basic green
  0603). `place_passive` finds these when given the right size.

## I2C

- One 4.7 kΩ pull-up on SDA and one on SCL to the bus voltage, once per bus (not per device).
- Use 2.2 kΩ for 400 kHz or long/heavily loaded buses.

## Buttons

- Switch between the GPIO and GND, with the MCU's internal pull-up or an external 10 kΩ pull-up.
- Add 100 nF across the switch if the firmware does not debounce.
- Basic tact switch: TS-1187A-B-A-B, C318884 (5.1 × 5.1 mm SMD). Search the MPN family
  ("TS-1187A"); "tactile switch" and "push button" don't find it.
- 4-pin tact switches join their pins in two pairs inside. Wire two diagonally opposite pins
  (1 and 4 on the TS-1187A), which works whichever way the pairs run, and mark the other two
  with `mark_no_connect`.

## Reset / enable

- 10 kΩ pull-up to the I/O rail plus 100 nF–1 µF to GND, so the chip starts after the supply is
  stable. A reset button goes from the pin to GND.
- Espressif modules: EN with 10 kΩ pull-up and 1 µF to GND.

## Crystals

- Load capacitors: C1 = C2 ≈ 2 × (C_L − C_stray), with C_stray ≈ 3–5 pF.
  For C_L = 12 pF, use 15–18 pF; for C_L = 20 pF, use 33 pF.
- Put the crystal and capacitors right next to the MCU's oscillator pins; capacitors to GND.

## 555 timer (astable)

- NE555DR (SOIC-8, C7593, preferred). RA from VCC to DISCH, RB from DISCH to THRES, and THRES
  tied to TRIG with the timing capacitor C to GND.
- f ≈ 1.44 / ((RA + 2·RB)·C); high time 0.693·(RA + RB)·C, low time 0.693·RB·C. Keep RA ≥ 1 kΩ.
  Example: 1 Hz with RA 10 kΩ, RB 68 kΩ, C 10 µF.
- RST to VCC, 10 nF from CONT to GND, 100 nF + 10 µF across the supply (the bipolar 555 draws
  current spikes when its output switches).
- Ceramic capacitors lose capacitance under DC bias and have ±10 % tolerance, so expect the
  frequency to run 10–20 % high; say so when timing matters.
- LED on OUT: the bipolar output high (≈ 3.3 V at 5 V) suits red LEDs (330–470 Ω). A green or
  blue LED has little headroom there: use 100 Ω and accept a few mA, or connect the LED from
  +5V to OUT so it lights while the output is low (this inverts the blink; with RST held low the
  output stays low, so the LED stays lit).
- Pulling RST low (a button to GND with a 10 kΩ pull-up) stops the timer with the output low.

## MCU minimum systems

**STM32 (F0/F1/F4…)**
- 100 nF on every VDD pin plus 4.7–10 µF bulk; VDDA with 1 µF + 10 nF.
- NRST: 100 nF to GND (internal pull-up), optional reset button to GND.
- BOOT0: 10 kΩ to GND (boot from flash).
- Optional 8 MHz HSE crystal with load capacitors; the internal oscillator works for most uses.
- SWD header: 3V3, SWDIO, SWCLK, GND (plus NRST).

**ESP32 modules (ESP32, -S3, -C3 WROOM/MINI)**
- 3.3 V from a 1 A-class regulator; 10 µF + 100 nF at the module's 3V3 pin.
- EN: 10 kΩ pull-up and 1 µF to GND, optional reset button to GND.
- Boot button from the boot strap pin to GND (GPIO0 on ESP32/-S3, GPIO9 on -C3) with a pull-up.
- Check the module datasheet for strapping pins before using them as general I/O.

**Anything else (RP2040, nRF52, ATmega…)**
Follow the manufacturer's minimal reference design (link in `get_part_details` → `datasheet`):
copy its power, clock, reset and programming parts into your plan before placing.

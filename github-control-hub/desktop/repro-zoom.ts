/**
 * Ctrl/Cmd + and Ctrl/Cmd − , which the app did not have.
 *
 * The cause is one line in `main`:
 *
 *     Menu.setApplicationMenu(null);
 *
 * `zoomIn`, `zoomOut` and `resetZoom` are Electron menu *roles*. They are not
 * built into a window; they are built into the default View menu, so an app
 * that throws the menu away to get a chrome-less frame throws the standard zoom
 * accelerators away with it. Nothing else registers them, and the keys do
 * nothing on either platform.
 *
 * Every check here is about the key mapping rather than the zooming, because
 * the zooming is one Electron call and the mapping is where the decisions are:
 * which modifier counts on which platform, and which of the several characters
 * a keyboard can produce for "plus" and "minus" we are willing to accept.
 *
 * This is testable at all only because zoom.ts imports Electron for types and
 * nothing else. `intentOf` takes the platform as an argument for the same
 * reason: the claim is about two platforms, and any one machine can only ever
 * run one of them.
 *
 * Run:  npx tsx repro-zoom.ts   from github-control-hub/desktop
 */
import type { Input } from "electron";
import { intentOf, clamp, snap } from "./src/zoom";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** An `Input` as Electron delivers one, with only the fields this reads. */
const key = (over: Partial<Input>): Input => ({
  type: "keyDown", key: "a", code: "KeyA",
  control: false, meta: false, shift: false, alt: false,
  isAutoRepeat: false, isComposing: false, location: 0, modifiers: [],
  ...over,
} as unknown as Input);

const win = (over: Partial<Input>) => intentOf(key({ control: true, ...over }), "win32");
const mac = (over: Partial<Input>) => intentOf(key({ meta: true, ...over }), "darwin");

console.log("the modifier is the platform's own");
{
  check("Ctrl on Windows", win({ key: "=" }) === "in");
  check("  and Cmd on macOS", mac({ key: "=" }) === "in");

  /**
   * Not interchangeable, in either direction. Ctrl+− on a Mac is not a zoom
   * shortcut anywhere else on the machine, and Cmd on Windows is the Windows
   * key, which belongs to the shell.
   */
  check("Ctrl alone does nothing on macOS",
    intentOf(key({ control: true, key: "=" }), "darwin") === null);
  check("  and Cmd alone does nothing on Windows",
    intentOf(key({ meta: true, key: "=" }), "win32") === null);
  check("Linux follows Windows",
    intentOf(key({ control: true, key: "=" }), "linux") === "in");
}

console.log("\nand \"plus\" means every character a keyboard calls plus");
{
  /**
   * The one that matters. On a US layout `+` is Shift and the `=` key, so
   * matching only "+" means the shortcut is really Ctrl+Shift+=, which nobody
   * presses on purpose. What people press is "control" and the key with the
   * plus printed on it.
   */
  check("Ctrl+= zooms in, which is what \"control plus\" actually is",
    win({ key: "=" }) === "in");
  check("  and so does Ctrl+Shift+= , which is the same key with Shift held",
    win({ key: "+", shift: true }) === "in");
  check("  and the numeric keypad's own + key",
    win({ key: "+", code: "NumpadAdd" }) === "in");

  check("Ctrl+- zooms out", win({ key: "-" }) === "out");
  // Shifted minus is "_", reached by anyone who has not let go of Shift after
  // zooming in. Silently doing nothing there reads as a shortcut that is flaky.
  check("  and so does Ctrl+_ , for a Shift not yet released",
    win({ key: "_", shift: true }) === "out");
  check("  and the keypad's − key",
    win({ key: "-", code: "NumpadSubtract" }) === "out");

  check("Ctrl+0 resets", win({ key: "0" }) === "reset");
  check("  including from the keypad", win({ key: "0", code: "Numpad0" }) === "reset");
}

console.log("\nand nothing else is a zoom");
{
  // This runs on every keystroke the window sees, including every character
  // typed into every field on the sign-in screen.
  check("an unmodified minus is just a minus",
    intentOf(key({ key: "-" }), "win32") === null);
  check("  and so is a letter with Ctrl held",
    win({ key: "c" }) === null && win({ key: "v" }) === null);
  check("  and a digit that is not zero",
    win({ key: "1" }) === null && win({ key: "9" }) === null);

  /**
   * Ctrl+Alt+− is a dead key for an em dash on several European layouts, and
   * AltGr arrives as Ctrl+Alt on Windows — so on those keyboards, not excluding
   * Alt would make ordinary characters zoom the window instead of typing.
   */
  check("Alt is excluded, because AltGr arrives as Ctrl+Alt",
    win({ key: "-", alt: true }) === null && mac({ key: "-", alt: true }) === null);

  // Otherwise every zoom is applied twice, once down and once up.
  check("keyUp is ignored, or every press would count twice",
    intentOf(key({ type: "keyUp", control: true, key: "=" }), "win32") === null);
}

console.log("\nand the level stays somewhere this layout still works in");
{
  // 1.2 ** -3 ≈ 58%, 1.2 ** 3 ≈ 173%, against a 1024-wide minimum window.
  check("it cannot be zoomed past the ends", clamp(99) === 3 && clamp(-99) === -3);
  check("  and an ordinary level is untouched", clamp(1.5) === 1.5);
  check("half steps, which is about 10% a press",
    Math.abs(1.2 ** 0.5 - 1.095) < 0.001);
  check("a stored level from some other range is snapped onto the steps",
    snap(1.3) === 1.5 && snap(0.1) === 0 && snap(-0.4) === -0.5,
    [snap(1.3), snap(0.1), snap(-0.4)]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

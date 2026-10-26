# Multi-threaded Towers of Hanoi with Air Traffic Control

**Live site:** https://jconning.github.io/multithreaded-towers-of-hanoi/

The classic recursive Towers of Hanoi, where every ring flies on its own thread.
Several rings can be airborne at once, and an air traffic controller keeps them from
colliding mid-air: a ring flies right up to the edge of the airspace still owned by
the ring ahead of it and holds there until it clears.

## Background

Jim Conning submitted *Multi-threaded Towers of Hanoi with Air Traffic Control* as an
entry into the Java Contest of 1995, which commemorated the launch of Java 1.0. It
was a Java applet that ran in the browser, with each ring flying on its own `Thread`.
It stopped working when Java 1.1 blocked `Thread.sleep()` for security reasons, and
the source code was lost. This is a re-creation, designed and implemented by
Claude Opus 5.5 on October 26, 2026.

## Stack

- Plain HTML, CSS and JavaScript. No framework, no build step, no dependencies.
- HTML5 Canvas for rendering.
- One Web Worker (a real OS thread) per ring flight, coordinated by an air traffic
  controller on the main thread through message passing.

The page itself explains the algorithm and the air traffic control rules in detail.

## Running locally

Open `index.html` in a browser. No server needed.

## License

© 2026 Jim Conning. Released under the [MIT License](LICENSE).

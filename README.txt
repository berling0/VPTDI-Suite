MSA15 Editor - Bosch MSA15.5 (EDC15-family) ECU dump tool for Windows

What it does
  - Merges the two chip dumps (LLL = even bytes, HHH = odd bytes) into one 256 KB bin; the order is detected
    from the data, so it does not matter which file you pick first.
  - Splits a combined bin back into LLL + HHH for flashing (verified to merge back to the identical image).
  - Finds the data blocks and every map automatically; names them from the built-in lists
    (028906021GK / GL / 0281001656 map pack, 038906018P / 0281001720 forum lists). Other software: load a map pack txt.
  - Shows single-value constants (IQ limits, MAP factor, boost limiter, idle RPM ...) per code block and the engine coding digit.
  - Compares two files map by map and constant by constant.
  - Edits: double-click a map value or axis point (shift-click to select cells, then Set / Add / Scale %), double-click a
    constant, Undo (Ctrl+Z) / Revert all. Axis units and names are shown for every identified map.
  - Tools tab: set the maximum injection quantity (51 mg -> any value; all limiter constants + diagnostic factors) and a
    hard rev limiter at a chosen rpm (rewrites the Torque limiter speed axis). No launch control: the firmware has none.
  - It does NOT correct the block checksums (algorithm unknown). After editing, fix them in your flashing tool / WinOLS.

Build (Go 1.24+, nothing else needed):
  build.bat            (or:  go build -trimpath -ldflags "-s -w -H windowsgui" -o "VAG VPTDI.exe" .)

Files
  web/core.js     all ECU logic: merge/split, map finder, naming, constants, compare
  web/app.js      user interface
  web/index.html  page and styles
  main.go         launcher: serves web/ on 127.0.0.1 and opens it in an Edge/Chrome app window
  maplists/       text map lists used as reference (format: <data address> <name> <columns>x<rows>)
  test/           node test/core.test.js <dumps folder> <ref folder>;  node test/ui.test.js ...;  node test/edit.ui.test.js <ref folder>   (the ECU dumps themselves are not in the repo)

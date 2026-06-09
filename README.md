# RISC-V Dump Assembly

VSCode language support for RISC-V objdump-style disassembly files.

## Features

- Syntax highlighting for file headers, disassembly sections, symbol labels, instruction addresses, machine code, mnemonics, registers, CSRs, immediates, comments, and `<symbol>` references.
- Automatic language detection for `.dump`, `.objdump`, `.dis`, `.disasm`, `.SText`, and `.stext` files.
- Outline view grouped by `Disassembly of section ...` headers and function labels such as `00000000 <_start>:`.
- Go to Definition and hover support for `<symbol>` references.
- Basic completion items for common RISC-V instructions, registers, and CSRs.

## Development

Open this folder in VSCode and press `F5` to launch an Extension Development Host. Open `jop.dump` or `rop.SText` in that host to verify highlighting and navigation.

To package the extension, install the VSCode extension packaging tool and run:

```powershell
npx @vscode/vsce package
```

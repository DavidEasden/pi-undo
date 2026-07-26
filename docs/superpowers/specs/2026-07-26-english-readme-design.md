# English README Redesign

## Goal

Replace the existing Chinese README with an English document that serves both Pi users and contributors. Users should be able to install and use the package from the first half of the page, while developers can continue reading for implementation constraints and local development instructions.

## Structure

The README will use this progressive structure:

1. Project summary
2. Features
3. Requirements
4. Installation
5. Usage
6. How it works
7. Safety and recovery
8. Limitations
9. Development
10. Testing
11. License

## Content Rules

- Use English throughout.
- Lead with the published install command: `pi install npm:@davideasden/pi-undo`.
- Document `/undo`, `/redo`, and the interaction with Pi's native `/tree` command.
- Explain that users do not manage Git, while Git must be installed because snapshots use a private object database.
- Preserve the actual behavior for streaming runs, prompt refill, ignored files, nested repositories, initialized submodules, WAL recovery, quarantine, and `recovery required` states.
- Include local package installation and direct extension loading for development.
- Include the existing npm scripts for tests, integration tests, type checking, watch mode, and package inspection.
- Do not document configuration, commands, guarantees, badges, or recovery tooling that the project does not implement.

## Verification

Review every command against `package.json` and the extension registration code. Check that installation examples use the scoped npm package, that the README is entirely English, and that npm packaging still includes the README without including `resources/`, tests, or local tarballs.

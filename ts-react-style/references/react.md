# React

## Components

- Declared as top-level `function` declarations, named export, one component
  per file.
- Props typed with an `interface` (e.g. `interface UserCardProps`).

## Hooks

- Custom hooks named `use*`, one per file, kebab-case filename.

## Styling

- Tailwind classes are auto-sorted by Biome inside `cn` / `clsx` / `cva` /
  `tw` — don't fight the order.

## Accessibility

- Every interactive element is keyboard-operable and focusable.

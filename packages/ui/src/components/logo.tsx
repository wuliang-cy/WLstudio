import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        data-slot="logo-logo-mark-w"
        d="M4 16H18L24 40L30 20H50L56 40L62 16H76L62 84H50L40 54L30 84H18Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M4 16H18L24 40L30 20H50L56 40L62 16H76L62 84H50L40 54L30 84H18Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(100.2 0) scale(0.42)">
        <path
          data-slot="logo-logo-w"
          d="M4 16H18L24 40L30 20H50L56 40L62 16H76L62 84H50L40 54L30 84H18Z"
          fill="var(--icon-strong-base)"
        />
      </g>
    </svg>
  )
}

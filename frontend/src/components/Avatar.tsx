import { colorForSeed, initialsFor } from "../utils/avatarColors";

export function Avatar({
  name,
  imageUrl,
  color,
  size = "md",
}: {
  name: string | null | undefined;
  imageUrl?: string | null;
  color?: string | null;
  size?: "sm" | "md" | "lg";
}): React.JSX.Element {
  if (imageUrl) {
    return (
      <span className={`avatar avatar--${size}`}>
        <img alt="" referrerPolicy="no-referrer" src={imageUrl} />
      </span>
    );
  }
  const background = color ?? colorForSeed(name ?? "codenaut");
  return (
    <span aria-hidden="true" className={`avatar avatar--${size}`} style={{ background }}>
      {initialsFor(name)}
    </span>
  );
}

import type { Card } from "./types";

const colorMap = {
  red: "#e74c3c",
  yellow: "#f1c40f",
  green: "#27ae60",
  blue: "#3498db",
  wild: "#34495e",
};

const valueDisplay = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  skip: "⊘",
  reverse: "⟲",
  draw2: "+2",
  wild: "🌈",
  wild4: "+4",
};

interface CardComponentProps {
  card: Card;
  onClick?: () => void;
  disabled?: boolean;
  faceDown?: boolean;
}

export function CardComponent({ card, onClick, disabled, faceDown }: CardComponentProps) {
  if (faceDown) {
    return (
      <div style={{
        width: "60px",
        height: "90px",
        background: "#2c3e50",
        borderRadius: "8px",
        border: "2px solid #34495e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "24px",
      }}>
        ?
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      style={{
        width: "60px",
        height: "90px",
        background: colorMap[card.color],
        borderRadius: "8px",
        border: "2px solid #fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "24px",
        fontWeight: "bold",
        color: "#fff",
        cursor: onClick && !disabled ? "pointer" : "default",
        opacity: disabled ? 0.5 : 1,
        transition: "transform 0.2s",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (onClick && !disabled) {
          e.currentTarget.style.transform = "translateY(-10px)";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      {valueDisplay[card.value]}
    </div>
  );
}
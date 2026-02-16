import React from "react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";

interface FeatureIconProps {
  icon: LucideIcon;
  color?: "purple" | "blue" | "green" | "orange";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const FeatureIcon: React.FC<FeatureIconProps> = ({
  icon: Icon,
  color = "purple",
  size = "md",
  className = "",
}) => {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const colorMap = {
    purple: {
      bg: isDark ? "bg-purple-500/10" : "bg-purple-100",
      border: isDark ? "border-purple-500/20" : "border-purple-200",
      text: isDark ? "text-purple-400" : "text-purple-600",
      glow: isDark ? "shadow-[0_0_15px_rgba(168,85,247,0.3)]" : "shadow-none",
      ring: isDark ? "ring-purple-500/20" : "ring-purple-200",
    },
    blue: {
      bg: isDark ? "bg-blue-500/10" : "bg-blue-100",
      border: isDark ? "border-blue-500/20" : "border-blue-200",
      text: isDark ? "text-blue-400" : "text-blue-600",
      glow: isDark ? "shadow-[0_0_15px_rgba(59,130,246,0.3)]" : "shadow-none",
      ring: isDark ? "ring-blue-500/20" : "ring-blue-200",
    },
    green: {
      bg: isDark ? "bg-green-500/10" : "bg-green-100",
      border: isDark ? "border-green-500/20" : "border-green-200",
      text: isDark ? "text-green-400" : "text-green-600",
      glow: isDark ? "shadow-[0_0_15px_rgba(34,197,94,0.3)]" : "shadow-none",
      ring: isDark ? "ring-green-500/20" : "ring-green-200",
    },
    orange: {
      bg: isDark ? "bg-orange-500/10" : "bg-orange-100",
      border: isDark ? "border-orange-500/20" : "border-orange-200",
      text: isDark ? "text-orange-400" : "text-orange-600",
      glow: isDark ? "shadow-[0_0_15px_rgba(249,115,22,0.3)]" : "shadow-none",
      ring: isDark ? "ring-orange-500/20" : "ring-orange-200",
    },
  };

  const sizeClass = {
    sm: "w-8 h-8 p-1.5",
    md: "w-12 h-12 p-3",
    lg: "w-16 h-16 p-4",
  };

  const styles = colorMap[color];

  return (
    <div className={`relative group ${className}`}>
      {/* Outer Glow Ring */}
      <div
        className={`absolute inset-0 rounded-xl ${styles.ring} ring-1 opacity-50 group-hover:opacity-100 transition-opacity`}
      />

      {/* Inner Background & Icon */}
      <div
        className={`relative flex items-center justify-center rounded-xl border backdrop-blur-sm transition-all duration-300 ${sizeClass[size]} ${styles.bg} ${styles.border} ${styles.text} ${styles.glow} group-hover:scale-105`}
      >
        <Icon className="w-full h-full stroke-[1.5]" />
      </div>
    </div>
  );
};

export default FeatureIcon;

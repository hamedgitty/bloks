declare module "lucide-react/dist/esm/icons/*.js" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
    size?: string | number;
    absoluteStrokeWidth?: boolean;
  } & RefAttributes<SVGSVGElement>;

  const Icon: ForwardRefExoticComponent<IconProps>;
  export default Icon;
}

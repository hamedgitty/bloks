// Every icon in the app, in one place. They are Heroicons (outline, the
// 24px set), wrapped so each takes the props the app has always passed:
// a size in pixels and an optional stroke, given on the old 2px scale and
// drawn at Heroicons' lighter weight, so a 2 is Heroicons' own 1.5 and
// nothing is drawn lighter than that. The
// names are the ones the components already use, which keeps a change of
// icon here and nowhere else. The few shapes Heroicons does not draw (the
// sidebar panels, a keyboard) are drawn here in its style: a 24px grid,
// a 1.5 stroke, round caps and joins.
import { forwardRef, type ComponentType, type SVGProps } from "react";
import AdjustmentsHorizontalHero from "@heroicons/react/24/outline/AdjustmentsHorizontalIcon.js";
import ArchiveBoxHero from "@heroicons/react/24/outline/ArchiveBoxIcon.js";
import ArrowDownHero from "@heroicons/react/24/outline/ArrowDownIcon.js";
import ArrowLeftStartOnRectangleHero from "@heroicons/react/24/outline/ArrowLeftStartOnRectangleIcon.js";
import WifiHero from "@heroicons/react/24/outline/WifiIcon.js";
import ArrowDownLeftHero from "@heroicons/react/24/outline/ArrowDownLeftIcon.js";
import ArrowDownTrayHero from "@heroicons/react/24/outline/ArrowDownTrayIcon.js";
import ArrowLeftHero from "@heroicons/react/24/outline/ArrowLeftIcon.js";
import Bars3Hero from "@heroicons/react/24/outline/Bars3Icon.js";
import ArrowPathHero from "@heroicons/react/24/outline/ArrowPathIcon.js";
import ArrowPathRoundedSquareHero from "@heroicons/react/24/outline/ArrowPathRoundedSquareIcon.js";
import ArrowRightHero from "@heroicons/react/24/outline/ArrowRightIcon.js";
import ArrowRightEndOnRectangleHero from "@heroicons/react/24/outline/ArrowRightEndOnRectangleIcon.js";
import ArrowTopRightOnSquareHero from "@heroicons/react/24/outline/ArrowTopRightOnSquareIcon.js";
import ArrowTurnDownLeftHero from "@heroicons/react/24/outline/ArrowTurnDownLeftIcon.js";
import ArrowTurnDownRightHero from "@heroicons/react/24/outline/ArrowTurnDownRightIcon.js";
import ArrowUpHero from "@heroicons/react/24/outline/ArrowUpIcon.js";
import ArrowUpRightHero from "@heroicons/react/24/outline/ArrowUpRightIcon.js";
import ArrowUpTrayHero from "@heroicons/react/24/outline/ArrowUpTrayIcon.js";
import ArrowUturnLeftHero from "@heroicons/react/24/outline/ArrowUturnLeftIcon.js";
import ArrowUturnRightHero from "@heroicons/react/24/outline/ArrowUturnRightIcon.js";
import ArrowsPointingInHero from "@heroicons/react/24/outline/ArrowsPointingInIcon.js";
import ArrowsPointingOutHero from "@heroicons/react/24/outline/ArrowsPointingOutIcon.js";
import BackspaceHero from "@heroicons/react/24/outline/BackspaceIcon.js";
import BeakerHero from "@heroicons/react/24/outline/BeakerIcon.js";
import BellAlertHero from "@heroicons/react/24/outline/BellAlertIcon.js";
import BellSlashHero from "@heroicons/react/24/outline/BellSlashIcon.js";
import BoltHero from "@heroicons/react/24/outline/BoltIcon.js";
import BookOpenHero from "@heroicons/react/24/outline/BookOpenIcon.js";
import BookmarkHero from "@heroicons/react/24/outline/BookmarkIcon.js";
import BookmarkSlashHero from "@heroicons/react/24/outline/BookmarkSlashIcon.js";
import BriefcaseHero from "@heroicons/react/24/outline/BriefcaseIcon.js";
import BuildingLibraryHero from "@heroicons/react/24/outline/BuildingLibraryIcon.js";
import CalendarDaysHero from "@heroicons/react/24/outline/CalendarDaysIcon.js";
import ChartBarHero from "@heroicons/react/24/outline/ChartBarIcon.js";
import ChartBarSquareHero from "@heroicons/react/24/outline/ChartBarSquareIcon.js";
import ChartPieHero from "@heroicons/react/24/outline/ChartPieIcon.js";
import ChatBubbleBottomCenterTextHero from "@heroicons/react/24/outline/ChatBubbleBottomCenterTextIcon.js";
import ChatBubbleLeftHero from "@heroicons/react/24/outline/ChatBubbleLeftIcon.js";
import ChatBubbleLeftRightHero from "@heroicons/react/24/outline/ChatBubbleLeftRightIcon.js";
import ChatBubbleOvalLeftHero from "@heroicons/react/24/outline/ChatBubbleOvalLeftIcon.js";
import ChatBubbleOvalLeftEllipsisHero from "@heroicons/react/24/outline/ChatBubbleOvalLeftEllipsisIcon.js";
import HomeModernHero from "@heroicons/react/24/outline/HomeModernIcon.js";
import CheckHero from "@heroicons/react/24/outline/CheckIcon.js";
import ChevronDownHero from "@heroicons/react/24/outline/ChevronDownIcon.js";
import ChevronLeftHero from "@heroicons/react/24/outline/ChevronLeftIcon.js";
import ChevronRightHero from "@heroicons/react/24/outline/ChevronRightIcon.js";
import ChevronUpHero from "@heroicons/react/24/outline/ChevronUpIcon.js";
import ChevronUpDownHero from "@heroicons/react/24/outline/ChevronUpDownIcon.js";
import ClipboardDocumentHero from "@heroicons/react/24/outline/ClipboardDocumentIcon.js";
import ClockHero from "@heroicons/react/24/outline/ClockIcon.js";
import CloudHero from "@heroicons/react/24/outline/CloudIcon.js";
import CodeBracketHero from "@heroicons/react/24/outline/CodeBracketIcon.js";
import Cog6ToothHero from "@heroicons/react/24/outline/Cog6ToothIcon.js";
import CommandLineHero from "@heroicons/react/24/outline/CommandLineIcon.js";
import ComputerDesktopHero from "@heroicons/react/24/outline/ComputerDesktopIcon.js";
import CpuChipHero from "@heroicons/react/24/outline/CpuChipIcon.js";
import DevicePhoneMobileHero from "@heroicons/react/24/outline/DevicePhoneMobileIcon.js";
import DocumentHero from "@heroicons/react/24/outline/DocumentIcon.js";
import DocumentDuplicateHero from "@heroicons/react/24/outline/DocumentDuplicateIcon.js";
import DocumentMagnifyingGlassHero from "@heroicons/react/24/outline/DocumentMagnifyingGlassIcon.js";
import DocumentMinusHero from "@heroicons/react/24/outline/DocumentMinusIcon.js";
import DocumentPlusHero from "@heroicons/react/24/outline/DocumentPlusIcon.js";
import DocumentTextHero from "@heroicons/react/24/outline/DocumentTextIcon.js";
import EllipsisHorizontalHero from "@heroicons/react/24/outline/EllipsisHorizontalIcon.js";
import EllipsisVerticalHero from "@heroicons/react/24/outline/EllipsisVerticalIcon.js";
import ExclamationTriangleHero from "@heroicons/react/24/outline/ExclamationTriangleIcon.js";
import EyeHero from "@heroicons/react/24/outline/EyeIcon.js";
import FaceSmileHero from "@heroicons/react/24/outline/FaceSmileIcon.js";
import FilmHero from "@heroicons/react/24/outline/FilmIcon.js";
import FingerPrintHero from "@heroicons/react/24/outline/FingerPrintIcon.js";
import FolderHero from "@heroicons/react/24/outline/FolderIcon.js";
import FolderOpenHero from "@heroicons/react/24/outline/FolderOpenIcon.js";
import GlobeAltHero from "@heroicons/react/24/outline/GlobeAltIcon.js";
import HandRaisedHero from "@heroicons/react/24/outline/HandRaisedIcon.js";
import InformationCircleHero from "@heroicons/react/24/outline/InformationCircleIcon.js";
import LightBulbHero from "@heroicons/react/24/outline/LightBulbIcon.js";
import LinkHero from "@heroicons/react/24/outline/LinkIcon.js";
import ListBulletHero from "@heroicons/react/24/outline/ListBulletIcon.js";
import LockClosedHero from "@heroicons/react/24/outline/LockClosedIcon.js";
import MagnifyingGlassHero from "@heroicons/react/24/outline/MagnifyingGlassIcon.js";
import MapPinHero from "@heroicons/react/24/outline/MapPinIcon.js";
import MicrophoneHero from "@heroicons/react/24/outline/MicrophoneIcon.js";
import MinusHero from "@heroicons/react/24/outline/MinusIcon.js";
import MoonHero from "@heroicons/react/24/outline/MoonIcon.js";
import NoSymbolHero from "@heroicons/react/24/outline/NoSymbolIcon.js";
import PaperAirplaneHero from "@heroicons/react/24/outline/PaperAirplaneIcon.js";
import PauseHero from "@heroicons/react/24/outline/PauseIcon.js";
import PencilHero from "@heroicons/react/24/outline/PencilIcon.js";
import PencilSquareHero from "@heroicons/react/24/outline/PencilSquareIcon.js";
import PhoneHero from "@heroicons/react/24/outline/PhoneIcon.js";
import PhoneXMarkHero from "@heroicons/react/24/outline/PhoneXMarkIcon.js";
import PhotoHero from "@heroicons/react/24/outline/PhotoIcon.js";
import PlayHero from "@heroicons/react/24/outline/PlayIcon.js";
import PlusHero from "@heroicons/react/24/outline/PlusIcon.js";
import PowerHero from "@heroicons/react/24/outline/PowerIcon.js";
import PresentationChartBarHero from "@heroicons/react/24/outline/PresentationChartBarIcon.js";
import PuzzlePieceHero from "@heroicons/react/24/outline/PuzzlePieceIcon.js";
import QuestionMarkCircleHero from "@heroicons/react/24/outline/QuestionMarkCircleIcon.js";
import QueueListHero from "@heroicons/react/24/outline/QueueListIcon.js";
import RectangleGroupHero from "@heroicons/react/24/outline/RectangleGroupIcon.js";
import RectangleStackHero from "@heroicons/react/24/outline/RectangleStackIcon.js";
import RssHero from "@heroicons/react/24/outline/RssIcon.js";
import ScaleHero from "@heroicons/react/24/outline/ScaleIcon.js";
import ServerHero from "@heroicons/react/24/outline/ServerIcon.js";
import ShieldCheckHero from "@heroicons/react/24/outline/ShieldCheckIcon.js";
import ShieldExclamationHero from "@heroicons/react/24/outline/ShieldExclamationIcon.js";
import SparklesHero from "@heroicons/react/24/outline/SparklesIcon.js";
import SpeakerWaveHero from "@heroicons/react/24/outline/SpeakerWaveIcon.js";
import Squares2X2Hero from "@heroicons/react/24/outline/Squares2X2Icon.js";
import StarHero from "@heroicons/react/24/outline/StarIcon.js";
import StopHero from "@heroicons/react/24/outline/StopIcon.js";
import StopCircleHero from "@heroicons/react/24/outline/StopCircleIcon.js";
import SunHero from "@heroicons/react/24/outline/SunIcon.js";
import TableCellsHero from "@heroicons/react/24/outline/TableCellsIcon.js";
import TrashHero from "@heroicons/react/24/outline/TrashIcon.js";
import UserHero from "@heroicons/react/24/outline/UserIcon.js";
import UserCircleHero from "@heroicons/react/24/outline/UserCircleIcon.js";
import UserGroupHero from "@heroicons/react/24/outline/UserGroupIcon.js";
import UserPlusHero from "@heroicons/react/24/outline/UserPlusIcon.js";
import ViewfinderCircleHero from "@heroicons/react/24/outline/ViewfinderCircleIcon.js";
import WalletHero from "@heroicons/react/24/outline/WalletIcon.js";
import WindowHero from "@heroicons/react/24/outline/WindowIcon.js";
import XMarkHero from "@heroicons/react/24/outline/XMarkIcon.js";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & { size?: number | string };
type Svg = ComponentType<SVGProps<SVGSVGElement>>;

/** The weight a component asked for, on the old scale, as Heroicons draws
 * it: never lighter than Heroicons' own 1.5, which is what it is drawn for. */
function stroke(asked: IconProps["strokeWidth"]): number {
  const n = asked === undefined ? 2 : Number(asked);
  return Number.isFinite(n) ? Math.max(1.5, n * 0.75) : 1.5;
}

function icon(Hero: Svg, name: string) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(({ size = 24, strokeWidth, ...rest }, ref) => (
    <Hero ref={ref} width={size} height={size} aria-hidden="true" {...rest} strokeWidth={stroke(strokeWidth)} />
  ));
  Icon.displayName = name;
  return Icon;
}

/** A shape Heroicons lacks, drawn on its grid with its stroke. */
function drawn(name: string, paths: React.ReactNode) {
  const Shape = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>((props, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths}
    </svg>
  ));
  Shape.displayName = `${name}Shape`;
  return icon(Shape as Svg, name);
}

const PanelLeftShape = drawn(
  "PanelLeft",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <path d="M9 4.5v15" />
  </>,
);
const PanelRightShape = drawn(
  "PanelRight",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <path d="M15 4.5v15" />
  </>,
);
const PanelBottomShape = drawn(
  "PanelBottom",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <path d="M3.75 14.25h16.5" />
  </>,
);
const PanelTopShape = drawn(
  "PanelTop",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <path d="M3.75 9.75h16.5" />
  </>,
);
// The terminal's layout choices: the whole window taken, and the window
// shared side by side. Filled shapes, on the same grid and stroke as the
// panels above, so the four sides and these two read as one set.
const PanelFillShape = drawn(
  "PanelFill",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <rect x="6.75" y="7.5" width="10.5" height="9" rx="0.75" fill="currentColor" stroke="none" />
  </>,
);
const PanelSplitShape = drawn(
  "PanelSplit",
  <>
    <rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" />
    <rect x="6.75" y="7.5" width="4.25" height="9" rx="0.75" fill="currentColor" stroke="none" opacity="0.45" />
    <rect x="13" y="7.5" width="4.25" height="9" rx="0.75" fill="currentColor" stroke="none" />
  </>,
);
// A conversation going two ways from one answer (Branch from here): a
// line that carries on, and one that leaves it.
const GitBranchShape = drawn(
  "GitBranch",
  <>
    <circle cx="6.75" cy="5.25" r="2.25" />
    <circle cx="6.75" cy="18.75" r="2.25" />
    <circle cx="17.25" cy="6.75" r="2.25" />
    <path d="M6.75 7.5v9" />
    <path d="M17.25 9v.75a3.75 3.75 0 0 1-3.75 3.75h-3a3.75 3.75 0 0 0-3.75 3" />
  </>,
);
// A handle to drag a row by: two columns of three dots, the mark every
// reorderable list uses, filled so they hold up at 14px.
const GripVerticalShape = drawn(
  "GripVertical",
  <>
    <circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />
  </>,
);
const KeyboardShape = drawn(
  "Keyboard",
  <>
    <rect x="2.25" y="6" width="19.5" height="12" rx="2.25" />
    <path d="M6 9.75h.01M9.25 9.75h.01M12.5 9.75h.01M15.75 9.75h.01M18 9.75h.01M6 12.75h.01M18 12.75h.01M8.25 15h7.5" />
    <path d="M9.25 12.75h5.5" />
  </>,
);

export const Activity = icon(ChartBarHero, "Activity");
export const Usage = icon(ChartBarSquareHero, "Usage");
export const AlertTriangle = icon(ExclamationTriangleHero, "AlertTriangle");
export const AppWindow = icon(WindowHero, "AppWindow");
export const Archive = icon(ArchiveBoxHero, "Archive");
export const ArrowDown = icon(ArrowDownHero, "ArrowDown");
export const ArrowDownLeft = icon(ArrowDownLeftHero, "ArrowDownLeft");
export const ArrowDownToLine = icon(ArrowDownTrayHero, "ArrowDownToLine");
export const ArrowLeft = icon(ArrowLeftHero, "ArrowLeft");
export const Menu = icon(Bars3Hero, "Menu");
export const ArrowRight = icon(ArrowRightHero, "ArrowRight");
export const ArrowUp = icon(ArrowUpHero, "ArrowUp");
export const ArrowUpRight = icon(ArrowUpRightHero, "ArrowUpRight");
export const AudioLines = icon(SpeakerWaveHero, "AudioLines");
export const Ban = icon(NoSymbolHero, "Ban");
export const BellDot = icon(BellAlertHero, "BellDot");
export const BellOff = icon(BellSlashHero, "BellOff");
export const BookOpen = icon(BookOpenHero, "BookOpen");
export const BookmarkPlus = icon(BookmarkHero, "BookmarkPlus");
export const Bot = icon(CpuChipHero, "Bot");
export const Brain = icon(LightBulbHero, "Brain");
export const Briefcase = icon(BriefcaseHero, "Briefcase");
export const CalendarClock = icon(CalendarDaysHero, "CalendarClock");
export const Check = icon(CheckHero, "Check");
export const ChevronDown = icon(ChevronDownHero, "ChevronDown");
export const ChevronLeft = icon(ChevronLeftHero, "ChevronLeft");
export const ChevronRight = icon(ChevronRightHero, "ChevronRight");
export const ChevronUp = icon(ChevronUpHero, "ChevronUp");
export const ChevronsUpDown = icon(ChevronUpDownHero, "ChevronsUpDown");
export const CircleDot = icon(ViewfinderCircleHero, "CircleDot");
export const CircleStop = icon(StopCircleHero, "CircleStop");
export const ClipboardCopy = icon(ClipboardDocumentHero, "ClipboardCopy");
export const Cloud = icon(CloudHero, "Cloud");
export const Copy = icon(DocumentDuplicateHero, "Copy");
export const CornerDownLeft = icon(ArrowTurnDownLeftHero, "CornerDownLeft");
export const CornerDownRight = icon(ArrowTurnDownRightHero, "CornerDownRight");
export const CornerUpLeft = icon(ArrowUturnLeftHero, "CornerUpLeft");
export const Cpu = icon(CpuChipHero, "Cpu");
export const Crown = icon(StarHero, "Crown");
export const Download = icon(ArrowDownTrayHero, "Download");
export const Eraser = icon(BackspaceHero, "Eraser");
export const ExternalLink = icon(ArrowTopRightOnSquareHero, "ExternalLink");
export const Eye = icon(EyeHero, "Eye");
export const File = icon(DocumentHero, "File");
export const FileCode = icon(CodeBracketHero, "FileCode");
export const FileDiff = icon(DocumentMagnifyingGlassHero, "FileDiff");
export const FileImage = icon(PhotoHero, "FileImage");
export const FileMinus = icon(DocumentMinusHero, "FileMinus");
export const FilePen = icon(PencilSquareHero, "FilePen");
export const FilePlus = icon(DocumentPlusHero, "FilePlus");
export const FileSpreadsheet = icon(TableCellsHero, "FileSpreadsheet");
export const FileText = icon(DocumentTextHero, "FileText");
export const FileVideo = icon(FilmHero, "FileVideo");
export const FingerprintPattern = icon(FingerPrintHero, "FingerprintPattern");
export const FlaskConical = icon(BeakerHero, "FlaskConical");
export const Folder = icon(FolderHero, "Folder");
export const FolderKanban = icon(RectangleGroupHero, "FolderKanban");
export const FolderOpen = icon(FolderOpenHero, "FolderOpen");
export const Gauge = icon(ChartPieHero, "Gauge");
export const GitBranch = GitBranchShape;
export const Globe = icon(GlobeAltHero, "Globe");
export const GripHorizontal = icon(EllipsisHorizontalHero, "GripHorizontal");
export const GripVertical = GripVerticalShape;
export const Hand = icon(HandRaisedHero, "Hand");
export const HelpCircle = icon(QuestionMarkCircleHero, "HelpCircle");
export const History = icon(ClockHero, "History");
export const Hourglass = icon(ClockHero, "Hourglass");
export const Info = icon(InformationCircleHero, "Info");
export const Keyboard = KeyboardShape;
export const LayoutGrid = icon(Squares2X2Hero, "LayoutGrid");
export const Library = icon(BuildingLibraryHero, "Library");
export const LibraryBig = icon(BuildingLibraryHero, "LibraryBig");
export const ListTree = icon(ListBulletHero, "ListTree");
export const Loader2 = icon(ArrowPathHero, "Loader2");
export const Lock = icon(LockClosedHero, "Lock");
export const LogIn = icon(ArrowRightEndOnRectangleHero, "LogIn");
export const Luggage = icon(BriefcaseHero, "Luggage");
export const MessageCircle = icon(ChatBubbleOvalLeftHero, "MessageCircle");
export const MessageSquare = icon(ChatBubbleLeftHero, "MessageSquare");
export const MessagesSquare = icon(ChatBubbleLeftRightHero, "MessagesSquare");
export const Mic = icon(MicrophoneHero, "Mic");
export const Minus = icon(MinusHero, "Minus");
export const Monitor = icon(ComputerDesktopHero, "Monitor");
export const Moon = icon(MoonHero, "Moon");
export const MoreHorizontal = icon(EllipsisHorizontalHero, "MoreHorizontal");
export const MapPin = icon(MapPinHero, "MapPin");
export const Maximize2 = icon(ArrowsPointingOutHero, "Maximize2");
export const Minimize2 = icon(ArrowsPointingInHero, "Minimize2");
export const MoreVertical = icon(EllipsisVerticalHero, "MoreVertical");
export const PanelBottom = PanelBottomShape;
export const PanelFill = PanelFillShape;
export const PanelSplit = PanelSplitShape;
export const PanelTop = PanelTopShape;
export const PanelLeft = PanelLeftShape;
export const PanelRight = PanelRightShape;
export const Pause = icon(PauseHero, "Pause");
export const Pencil = icon(PencilHero, "Pencil");
export const Phone = icon(PhoneHero, "Phone");
export const PhoneOff = icon(PhoneXMarkHero, "PhoneOff");
export const PictureInPicture2 = icon(WindowHero, "PictureInPicture2");
export const Pin = icon(BookmarkHero, "Pin");
export const PinOff = icon(BookmarkSlashHero, "PinOff");
export const Play = icon(PlayHero, "Play");
export const Plus = icon(PlusHero, "Plus");
export const Power = icon(PowerHero, "Power");
export const Presentation = icon(PresentationChartBarHero, "Presentation");
export const Puzzle = icon(PuzzlePieceHero, "Puzzle");
export const Quote = icon(ChatBubbleBottomCenterTextHero, "Quote");
export const RefreshCw = icon(ArrowPathHero, "RefreshCw");
export const Repeat = icon(ArrowPathRoundedSquareHero, "Repeat");
export const RotateCcw = icon(ArrowUturnLeftHero, "RotateCcw");
export const RotateCw = icon(ArrowUturnRightHero, "RotateCw");
export const Rows3 = icon(QueueListHero, "Rows3");
export const Rss = icon(RssHero, "Rss");
export const Scale = icon(ScaleHero, "Scale");
export const Search = icon(MagnifyingGlassHero, "Search");
export const Send = icon(PaperAirplaneHero, "Send");
export const Server = icon(ServerHero, "Server");
export const Settings = icon(Cog6ToothHero, "Settings");
export const Settings2 = icon(AdjustmentsHorizontalHero, "Settings2");
export const ShieldAlert = icon(ShieldExclamationHero, "ShieldAlert");
export const ShieldCheck = icon(ShieldCheckHero, "ShieldCheck");
export const SlidersHorizontal = icon(AdjustmentsHorizontalHero, "SlidersHorizontal");
export const Smartphone = icon(DevicePhoneMobileHero, "Smartphone");
export const MessageDots = icon(ChatBubbleOvalLeftEllipsisHero, "MessageDots");
export const House = icon(HomeModernHero, "House");
export const SmilePlus = icon(FaceSmileHero, "SmilePlus");
export const Sparkles = icon(SparklesHero, "Sparkles");
export const Square = icon(StopHero, "Square");
export const SquarePen = icon(PencilSquareHero, "SquarePen");
export const SquareTerminal = icon(CommandLineHero, "SquareTerminal");
export const Sun = icon(SunHero, "Sun");
export const Sunrise = icon(SunHero, "Sunrise");
export const Target = icon(ViewfinderCircleHero, "Target");
export const Trash2 = icon(TrashHero, "Trash2");
export const TriangleAlert = icon(ExclamationTriangleHero, "TriangleAlert");
export const Undo2 = icon(ArrowUturnLeftHero, "Undo2");
export const Upload = icon(ArrowUpTrayHero, "Upload");
export const User = icon(UserHero, "User");
export const UserPlus = icon(UserPlusHero, "UserPlus");
export const UserRound = icon(UserCircleHero, "UserRound");
export const Users = icon(UserGroupHero, "Users");
export const Volume2 = icon(SpeakerWaveHero, "Volume2");
export const Wallet = icon(WalletHero, "Wallet");
export const Webhook = icon(LinkHero, "Webhook");
export const Workflow = icon(RectangleStackHero, "Workflow");
export const X = icon(XMarkHero, "X");
export const Zap = icon(BoltHero, "Zap");
export const Wifi = icon(WifiHero, "Wifi");
export const LogOut = icon(ArrowLeftStartOnRectangleHero, "LogOut");

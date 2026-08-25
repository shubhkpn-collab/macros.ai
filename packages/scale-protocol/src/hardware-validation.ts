/**
 * CORNER-LOAD QUALIFICATION — A HARDWARE REQUIREMENT, NOT A SOFTWARE FEATURE.
 *
 * Off-centre placement on a poorly designed platform produces systematic errors
 * that are invisible to the user and cannot be corrected in software without
 * real supplier characterization data. MACROS.AI therefore ships NO corner-load
 * compensation. This module defines only the SHAPE of the qualification record
 * so results can be captured consistently when physical units exist.
 */
export type LoadPosition =
  | 'center'
  | 'front_left'
  | 'front_right'
  | 'rear_left'
  | 'rear_right'
  | 'supplier_defined';

export interface CornerLoadMeasurement {
  readonly position: LoadPosition;
  readonly supplierPositionLabel?: string;
  readonly referenceMassGrams: number;
  readonly measuredGrams: number;
  readonly errorGrams: number;
  readonly repeatabilityGrams?: number;
  readonly temperatureCelsius?: number;
  readonly firmwareVersion?: string;
  readonly calibrationVersion?: string;
  readonly unitSerial: string;
}

export interface CornerLoadQualification {
  readonly unitSerial: string;
  readonly hardwareRevision: string;
  readonly measurements: readonly CornerLoadMeasurement[];
  readonly status: 'PENDING_HARDWARE_VALIDATION' | 'PASSED' | 'FAILED';
}

/**
 * Positions every certified reference mass must be tested at, plus any
 * supplier-defined points. Recorded here so the requirement is not lost between
 * this milestone and physical qualification.
 */
export const REQUIRED_CORNER_LOAD_POSITIONS: readonly LoadPosition[] = [
  'center',
  'front_left',
  'front_right',
  'rear_left',
  'rear_right',
];

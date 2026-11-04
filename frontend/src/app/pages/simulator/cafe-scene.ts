/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

interface CafeCustomer {
  mesh: THREE.Mesh;
  type: 'dine-in' | 'takeout';
  targetX: number;
  targetZ: number;
  speed: number;
  state: 'entering' | 'queuing' | 'ordering' | 'waiting-drink' | 'sitting' | 'leaving';
  timer: number;
  assignedSeat: THREE.Vector3 | null;
  assignedSeatIdx: number;
}

interface CafeStaff {
  mesh: THREE.Mesh;
  role: 'barista' | 'floor';
  targetX: number;
  targetZ: number;
  speed: number;
  state: 'idle' | 'moving-to-table' | 'clearing' | 'returning';
  timer: number;
  assignedDirtyTable: number | null;
  homePosition: THREE.Vector3;
}

interface DollarEffect {
  sprite: THREE.Sprite;
  timer: number;
  startY: number;
}

export class CafeScene {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private animationId = 0;
  private customers: CafeCustomer[] = [];
  private staff: CafeStaff[] = [];
  private isActive = false;
  private clock = new THREE.Clock();
  private customerCount = 6;
  private speedMultiplier = 1;
  private dollarEffects: DollarEffect[] = [];
  private dollarTexture!: THREE.Texture;
  private orbitControls!: OrbitControls;
  private transformControls!: TransformControls;
  private selectableObjects: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private selectedObject: THREE.Object3D | null = null;

  // Layout positions
  private queuePositions: THREE.Vector3[] = [];
  private pickupPosition = new THREE.Vector3(5, 0, 2);
  private seatPositions: THREE.Vector3[] = []; // one per table (1 seat position per table number)
  private foodPositions: THREE.Vector3[] = []; // where food/clutter appears (bar counter for stools)
  private occupiedSeats = new Set<number>();
  private dirtyTables = new Set<number>();
  private tableItems = new Map<number, THREE.Group>();
  private counterPosition = new THREE.Vector3(3, 0, 5);
  private entrancePosition = new THREE.Vector3(0, 0, -14);

  // Table configuration
  private floorTableCount = 9; // number of round/rect tables on the floor
  private readonly barSeatCount = 6; // window bar always 6
  private floorTableObjects: THREE.Object3D[] = [];
  private floorTableLabels: THREE.Sprite[] = [];

  onTransaction: ((orderType: 'dine-in' | 'takeout') => void) | null = null;
  onTableEvent: ((tableId: string, event: 'occupied' | 'dirty' | 'cleared', source: string) => void) | null = null;
  onTableCountChanged: ((totalTables: number) => void) | null = null;
  onFootfall: ((count: number, zone: string) => void) | null = null;

  // Footfall reporting cadence (sim-seconds between people-count observations).
  private footfallTimer = 0;
  private readonly footfallInterval = 5;

  get totalTableCount(): number {
    return this.floorTableCount + this.barSeatCount;
  }

  constructor(private canvas: HTMLCanvasElement) {}

  init(): void {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.setClearColor(0xfaf3e0);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xfaf3e0, 60, 120);

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, this.canvas.clientWidth / this.canvas.clientHeight, 0.1, 200);
    this.camera.position.set(25, 20, 25);
    this.camera.lookAt(0, 0, 0);

    // OrbitControls
    this.orbitControls = new OrbitControls(this.camera, this.canvas);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.1;
    this.orbitControls.maxPolarAngle = Math.PI / 2.1;
    this.orbitControls.minDistance = 8;
    this.orbitControls.maxDistance = 80;

    // TransformControls
    this.transformControls = new TransformControls(this.camera, this.canvas);
    this.transformControls.addEventListener('dragging-changed', (event: any) => {
      this.orbitControls.enabled = !event.value;
    });
    this.scene.add(this.transformControls);

    // Lighting - warm café ambiance
    const ambientLight = new THREE.AmbientLight(0xfff5e6, 0.5);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(15, 25, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 80;
    dirLight.shadow.camera.left = -25;
    dirLight.shadow.camera.right = 25;
    dirLight.shadow.camera.top = 25;
    dirLight.shadow.camera.bottom = -25;
    this.scene.add(dirLight);

    // Warm point lights (pendant lamps)
    const warmColors = [0xffcc66, 0xffbb44, 0xffdd88];
    const lampPositions = [
      [-6, 5, -4], [0, 5, -4], [6, 5, -4],
      [-6, 5, 2], [0, 5, 2], [6, 5, 2]
    ];
    lampPositions.forEach((pos, i) => {
      const light = new THREE.PointLight(warmColors[i % warmColors.length], 0.4, 12);
      light.position.set(pos[0], pos[1], pos[2]);
      this.scene.add(light);
    });

    this.dollarTexture = this.createDollarTexture();
    this.buildCafe();
    this.spawnCustomers(this.customerCount);
    this.spawnStaff();

    // Event listeners
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('keydown', this.onKeyDown);

    this.animate();
  }

  // --- Café Layout based on reference image ---
  private buildCafe(): void {
    // Floor (30 x 30 café space)
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x8b6914 }); // warm wood floor
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Walls (half-height for open-top visibility)
    this.addWall(0, 1.5, 15, 30, 3, 0.3, 0xf5e6d3);   // Back wall
    this.addWall(-15, 1.5, 0, 0.3, 3, 30, 0xf5e6d3);   // Left wall
    this.addWall(15, 1.5, 0, 0.3, 3, 30, 0xf5e6d3);    // Right wall
    this.addWall(-7.5, 1.5, -15, 15, 3, 0.3, 0xf5e6d3); // Front-left wall
    this.addWall(7.5, 1.5, -15, 15, 3, 0.3, 0xf5e6d3);  // Front-right wall (with entrance gap)

    // Entrance door frame
    const doorFrameGeo = new THREE.BoxGeometry(0.3, 3, 0.5);
    const doorFrameMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });
    const leftDoor = new THREE.Mesh(doorFrameGeo, doorFrameMat);
    leftDoor.position.set(-0.5, 1.5, -15);
    this.scene.add(leftDoor);
    const rightDoor = new THREE.Mesh(doorFrameGeo, doorFrameMat);
    rightDoor.position.set(0.5, 1.5, -15);
    this.scene.add(rightDoor);

    // --- SECTIONS ---
    this.buildCounter();
    this.buildEspressoStation();
    this.buildPastryDisplay();
    this.buildSeatingArea();
    this.buildWindowBar();
    this.buildDecor();
    this.addZoneLabels();
  }

  // L-shaped counter with register
  private buildCounter(): void {
    const counterMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });
    const topMat = new THREE.MeshLambertMaterial({ color: 0xd4a574 });

    // Main counter (horizontal section) - order area
    const mainCounterGeo = new THREE.BoxGeometry(8, 1.1, 1.5);
    const mainCounter = new THREE.Mesh(mainCounterGeo, counterMat);
    mainCounter.position.set(3, 0.55, 6);
    mainCounter.castShadow = true;
    this.scene.add(mainCounter);
    this.selectableObjects.push(mainCounter);

    // Counter top
    const topGeo = new THREE.BoxGeometry(8.2, 0.1, 1.7);
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.set(3, 1.15, 6);
    this.scene.add(top);

    // L-extension (vertical section) - pickup area
    const extGeo = new THREE.BoxGeometry(1.5, 1.1, 6);
    const ext = new THREE.Mesh(extGeo, counterMat);
    ext.position.set(7.5, 0.55, 9.5);
    ext.castShadow = true;
    this.scene.add(ext);
    this.selectableObjects.push(ext);

    const extTopGeo = new THREE.BoxGeometry(1.7, 0.1, 6.2);
    const extTop = new THREE.Mesh(extTopGeo, topMat);
    extTop.position.set(7.5, 1.15, 9.5);
    this.scene.add(extTop);

    // Cash register
    const registerGeo = new THREE.BoxGeometry(0.5, 0.4, 0.4);
    const registerMat = new THREE.MeshLambertMaterial({ color: 0x212121 });
    const register = new THREE.Mesh(registerGeo, registerMat);
    register.position.set(1, 1.4, 6);
    register.castShadow = true;
    this.scene.add(register);

    // Queue positions (in front of counter, going toward entrance)
    this.counterPosition.set(1, 0, 4);
    for (let i = 0; i < 8; i++) {
      this.queuePositions.push(new THREE.Vector3(1, 0, 3 - i * 1.5));
    }

    // Pickup position (end of L-counter)
    this.pickupPosition.set(7.5, 0, 7);
  }

  // Espresso machines & barista station behind counter
  private buildEspressoStation(): void {
    const machineMat = new THREE.MeshLambertMaterial({ color: 0x37474f });
    const chromeMat = new THREE.MeshLambertMaterial({ color: 0xc0c0c0 });

    // Back counter/shelf
    const shelfGeo = new THREE.BoxGeometry(10, 1, 1);
    const shelfMat = new THREE.MeshLambertMaterial({ color: 0x4e342e });
    const shelf = new THREE.Mesh(shelfGeo, shelfMat);
    shelf.position.set(3, 1, 12);
    this.scene.add(shelf);

    // Espresso machine 1
    const machineGeo = new THREE.BoxGeometry(1.2, 1.5, 0.8);
    const machine1 = new THREE.Mesh(machineGeo, machineMat);
    machine1.position.set(1, 2, 12);
    machine1.castShadow = true;
    this.scene.add(machine1);
    this.selectableObjects.push(machine1);

    // Espresso machine 2
    const machine2 = new THREE.Mesh(machineGeo, machineMat);
    machine2.position.set(3.5, 2, 12);
    machine2.castShadow = true;
    this.scene.add(machine2);
    this.selectableObjects.push(machine2);

    // Grinder
    const grinderGeo = new THREE.BoxGeometry(0.5, 1, 0.5);
    const grinder = new THREE.Mesh(grinderGeo, chromeMat);
    grinder.position.set(5.5, 1.8, 12);
    grinder.castShadow = true;
    this.scene.add(grinder);

    // Menu board on back wall
    const boardGeo = new THREE.BoxGeometry(6, 2.5, 0.1);
    const boardMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.set(3, 3.5, 14.8);
    this.scene.add(board);
    this.selectableObjects.push(board);
  }

  // Pastry display case near the register
  private buildPastryDisplay(): void {
    const glassMat = new THREE.MeshLambertMaterial({ color: 0xb3e5fc, transparent: true, opacity: 0.4 });
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });

    // Display case
    const caseGeo = new THREE.BoxGeometry(2.5, 1.2, 1.2);
    const displayCase = new THREE.Mesh(caseGeo, glassMat);
    displayCase.position.set(-2, 0.6, 6);
    displayCase.castShadow = true;
    this.scene.add(displayCase);

    // Frame
    const frameGeo = new THREE.BoxGeometry(2.6, 0.1, 1.3);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.set(-2, 1.2, 6);
    this.scene.add(frame);
    this.selectableObjects.push(displayCase);

    // Pastry items inside (small colored cubes as pastries)
    const pastryColors = [0xf9a825, 0x8d6e63, 0xffccbc, 0xffe0b2];
    for (let i = 0; i < 4; i++) {
      const pastryGeo = new THREE.SphereGeometry(0.2, 8, 8);
      const pastry = new THREE.Mesh(pastryGeo, new THREE.MeshLambertMaterial({ color: pastryColors[i] }));
      pastry.position.set(-2.5 + i * 0.5, 0.3, 6);
      this.scene.add(pastry);
    }
  }

  // Seating area - dynamically generated mix of round and rectangular tables
  private buildSeatingArea(): void {
    this.clearFloorTables();

    const tableMat = new THREE.MeshLambertMaterial({ color: 0x8d6e63 });
    const chairMat = new THREE.MeshLambertMaterial({ color: 0x5d4037 });

    // Generate grid positions for floor tables (left + center area)
    const gridPositions = this.computeFloorTablePositions(this.floorTableCount);

    gridPositions.forEach((pos, idx) => {
      const isRound = Math.random() < 0.5;
      const tableNum = idx + 1; // tables numbered starting at 1

      if (isRound) {
        this.buildRoundTable(pos[0], pos[1], tableNum, tableMat, chairMat);
      } else {
        this.buildRectTable(pos[0], pos[1], tableNum, tableMat, chairMat);
      }
    });
  }

  private computeFloorTablePositions(count: number): number[][] {
    // Valid seating zones avoiding:
    //   Counter/kitchen: z >= 4 (counter at z=6, espresso at z=12)
    //   Queue corridor: x in [-0.5, 2.5] for z > -12 to 4
    //   Bar area: x >= 11 (bar counter at x=14)
    //   Walls: x < -13 or x > 13, z < -13 or z > 13
    const spacing = 3.5;
    const candidates: number[][] = [];

    // Generate grid candidates in the dining area
    for (let x = -12; x <= 10; x += spacing) {
      for (let z = -12; z <= 2; z += spacing) {
        // Skip queue corridor (x roughly 0-2, extends from entrance toward counter)
        if (x >= -1 && x <= 3 && z >= -12) continue;
        // Skip area near pastry display case (x=-2, z=6 area)
        if (x >= -3.5 && x <= -0.5) continue;
        candidates.push([x, z]);
      }
    }

    // Return up to `count` positions from available candidates
    return candidates.slice(0, count);
  }

  private buildRoundTable(x: number, z: number, tableNum: number, tableMat: THREE.Material, chairMat: THREE.Material): void {
    const group = new THREE.Group();

    // Table top (round)
    const tableGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.08, 16);
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.set(0, 1.0, 0);
    table.castShadow = true;
    group.add(table);

    // Table leg
    const legGeo = new THREE.CylinderGeometry(0.1, 0.15, 1.0, 8);
    const leg = new THREE.Mesh(legGeo, new THREE.MeshLambertMaterial({ color: 0x37474f }));
    leg.position.set(0, 0.5, 0);
    group.add(leg);

    // Chairs (2)
    this.addChair(group, -0.9, 0, chairMat);
    this.addChair(group, 0.9, 0, chairMat);

    group.position.set(x, 0, z);
    this.scene.add(group);
    this.selectableObjects.push(group);
    this.floorTableObjects.push(group);

    // Table label
    const label = this.addTableLabel(x, z, tableNum);
    this.floorTableLabels.push(label);

    // Register one seat position per table
    this.seatPositions.push(new THREE.Vector3(x, 0, z));
    this.foodPositions.push(new THREE.Vector3(x, 0, z));
  }

  private buildRectTable(x: number, z: number, tableNum: number, tableMat: THREE.Material, chairMat: THREE.Material): void {
    const group = new THREE.Group();

    // Table top (rectangular)
    const tableGeo = new THREE.BoxGeometry(2, 0.08, 1.2);
    const table = new THREE.Mesh(tableGeo, tableMat);
    table.position.set(0, 1.0, 0);
    table.castShadow = true;
    group.add(table);

    // 4 legs
    const legGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x37474f });
    [[-0.8, -0.5], [0.8, -0.5], [-0.8, 0.5], [0.8, 0.5]].forEach(([lx, lz]) => {
      const l = new THREE.Mesh(legGeo, legMat);
      l.position.set(lx, 0.5, lz);
      group.add(l);
    });

    // 4 chairs
    this.addChair(group, -0.9, 1, chairMat);
    this.addChair(group, 0.9, 1, chairMat);
    this.addChair(group, -0.9, -1, chairMat);
    this.addChair(group, 0.9, -1, chairMat);

    group.position.set(x, 0, z);
    this.scene.add(group);
    this.selectableObjects.push(group);
    this.floorTableObjects.push(group);

    // Table label
    const label = this.addTableLabel(x, z, tableNum);
    this.floorTableLabels.push(label);

    // Register one seat position per table
    this.seatPositions.push(new THREE.Vector3(x, 0, z));
    this.foodPositions.push(new THREE.Vector3(x, 0, z));
  }

  private clearFloorTables(): void {
    // Remove existing floor table objects and labels
    for (const obj of this.floorTableObjects) {
      this.scene.remove(obj);
      const idx = this.selectableObjects.indexOf(obj);
      if (idx >= 0) this.selectableObjects.splice(idx, 1);
    }
    for (const label of this.floorTableLabels) {
      this.scene.remove(label);
    }
    this.floorTableObjects = [];
    this.floorTableLabels = [];

    // Clear only floor table seat positions (keep bar stools at the end)
    // Seat positions [0..floorTableCount-1] are floor tables, rest are bar stools
    // We'll rebuild them fresh, so clear and let buildWindowBar re-add bar seats
    this.seatPositions = [];
    this.foodPositions = [];
    this.occupiedSeats.clear();
    this.dirtyTables.clear();
    this.tableItems.forEach(group => this.scene.remove(group));
    this.tableItems.clear();
  }

  // Window bar seating along right wall
  private barStoolObjects: THREE.Object3D[] = [];
  private barStoolLabels: THREE.Sprite[] = [];
  private barStructureBuilt = false;

  private buildWindowBar(): void {
    const stoolMat = new THREE.MeshLambertMaterial({ color: 0x37474f });

    // Build static bar structure only once
    if (!this.barStructureBuilt) {
      const barMat = new THREE.MeshLambertMaterial({ color: 0x8d6e63 });

      // Bar counter along right wall
      const barGeo = new THREE.BoxGeometry(0.8, 1.1, 16);
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.set(14, 0.55, 0);
      bar.castShadow = true;
      this.scene.add(bar);
      this.selectableObjects.push(bar);

      // Bar top
      const barTopGeo = new THREE.BoxGeometry(1.2, 0.08, 16.2);
      const barTopMat = new THREE.MeshLambertMaterial({ color: 0xd4a574 });
      const barTop = new THREE.Mesh(barTopGeo, barTopMat);
      barTop.position.set(14, 1.12, 0);
      this.scene.add(barTop);

      // Windows on right wall
      const windowMat = new THREE.MeshLambertMaterial({ color: 0xbbdefb, transparent: true, opacity: 0.5 });
      for (let i = 0; i < 4; i++) {
        const windowGeo = new THREE.BoxGeometry(0.1, 2, 3);
        const win = new THREE.Mesh(windowGeo, windowMat);
        win.position.set(14.9, 3, -6 + i * 4);
        this.scene.add(win);
      }

      this.barStructureBuilt = true;
    }

    // Remove old stool objects and labels (for rebuild on table count change)
    for (const obj of this.barStoolObjects) {
      this.scene.remove(obj);
    }
    for (const label of this.barStoolLabels) {
      this.scene.remove(label);
    }
    this.barStoolObjects = [];
    this.barStoolLabels = [];

    // Bar stools - each is 1 table, numbered after floor tables
    for (let i = 0; i < this.barSeatCount; i++) {
      const z = -7.5 + i * 3;
      const stoolGroup = new THREE.Group();

      // Stool seat
      const seatGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12);
      const seat = new THREE.Mesh(seatGeo, stoolMat);
      seat.position.set(0, 0.9, 0);
      stoolGroup.add(seat);

      // Stool leg
      const legGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.9, 8);
      const leg = new THREE.Mesh(legGeo, stoolMat);
      leg.position.set(0, 0.45, 0);
      stoolGroup.add(leg);

      stoolGroup.position.set(12.8, 0, z);
      this.scene.add(stoolGroup);
      this.barStoolObjects.push(stoolGroup);

      // Bar stool label: numbered after floor tables
      const tableNum = this.floorTableCount + i + 1;
      const label = this.addTableLabel(12.8, z, tableNum);
      this.barStoolLabels.push(label);

      // One seat position per bar stool table
      this.seatPositions.push(new THREE.Vector3(12.8, 0, z));
      // Food goes on the bar counter surface, not on the stool
      this.foodPositions.push(new THREE.Vector3(13.8, 0, z));
    }
  }

  // Decorations
  private buildDecor(): void {
    // Potted plants
    const potMat = new THREE.MeshLambertMaterial({ color: 0x795548 });
    const plantMat = new THREE.MeshLambertMaterial({ color: 0x4caf50 });

    const plantPositions = [[-13, -13], [13, -13], [-13, 13]];
    plantPositions.forEach(([px, pz]) => {
      const potGeo = new THREE.CylinderGeometry(0.4, 0.3, 0.6, 8);
      const pot = new THREE.Mesh(potGeo, potMat);
      pot.position.set(px, 0.3, pz);
      this.scene.add(pot);

      const leafGeo = new THREE.SphereGeometry(0.6, 8, 8);
      const leaf = new THREE.Mesh(leafGeo, plantMat);
      leaf.position.set(px, 1.2, pz);
      this.scene.add(leaf);
    });

    // Pendant lamp fixtures (no ceiling - open top for visibility)
    const fixtureMat = new THREE.MeshLambertMaterial({ color: 0x212121 });
    const lampPositions = [
      [-6, -4], [0, -4], [6, -4],
      [-6, 2], [0, 2], [6, 2]
    ];
    lampPositions.forEach(([lx, lz]) => {
      const fixtureGeo = new THREE.ConeGeometry(0.4, 0.5, 8);
      const fixture = new THREE.Mesh(fixtureGeo, fixtureMat);
      fixture.position.set(lx, 4.7, lz);
      fixture.rotation.x = Math.PI;
      this.scene.add(fixture);

      // Cord
      const cordGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 4);
      const cord = new THREE.Mesh(cordGeo, fixtureMat);
      cord.position.set(lx, 4.95, lz);
      this.scene.add(cord);
    });
  }

  private addChair(parent: THREE.Group, x: number, z: number, mat: THREE.Material): void {
    const seatGeo = new THREE.BoxGeometry(0.5, 0.06, 0.5);
    const seat = new THREE.Mesh(seatGeo, mat);
    seat.position.set(x, 0.55, z);
    parent.add(seat);

    const backGeo = new THREE.BoxGeometry(0.5, 0.5, 0.06);
    const back = new THREE.Mesh(backGeo, mat);
    back.position.set(x, 0.85, z + (z > 0 ? 0.25 : -0.25));
    parent.add(back);
  }

  private addTableLabel(x: number, z: number, tableNum: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    // Background pill
    ctx.fillStyle = 'rgba(55, 71, 79, 0.85)';
    const radius = 12;
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 56, radius);
    ctx.fill();

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`T${tableNum}`, 64, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(x, 2.2, z);
    sprite.scale.set(1.4, 0.7, 1);
    this.scene.add(sprite);
    return sprite;
  }

  private addWall(x: number, y: number, z: number, w: number, h: number, d: number, color: number): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshLambertMaterial({ color });
    const wall = new THREE.Mesh(geo, mat);
    wall.position.set(x, y, z);
    wall.receiveShadow = true;
    this.scene.add(wall);
  }

  private addZoneLabels(): void {
    const labels = [
      { text: 'ORDER HERE', x: 1, z: 3 },
      { text: 'PICKUP', x: 7.5, z: 5 },
      { text: 'ESPRESSO BAR', x: 3, z: 11 },
      { text: 'PASTRIES', x: -2, z: 4.5 },
      { text: 'SEATING', x: -6, z: -3 },
      { text: 'WINDOW BAR', x: 13, z: 0 },
    ];

    labels.forEach(({ text, x, z }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.roundRect(0, 0, 256, 64, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 128, 32);

      const texture = new THREE.CanvasTexture(canvas);
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, 3.5, z);
      sprite.scale.set(3, 0.75, 1);
      this.scene.add(sprite);
    });
  }

  // --- Customer spawning ---
  private spawnCustomers(count: number): void {
    for (let i = 0; i < count; i++) {
      this.spawnCustomer();
    }
  }

  private spawnCustomer(): void {
    const isTakeout = Math.random() < 0.6;
    const colors = isTakeout ? 0xff9800 : 0x7b1fa2; // orange = takeout, purple = dine-in
    const geo = new THREE.CapsuleGeometry(0.3, 0.6, 4, 8);
    const mat = new THREE.MeshLambertMaterial({ color: colors });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      this.entrancePosition.x + (Math.random() - 0.5) * 2,
      0.6,
      this.entrancePosition.z
    );
    mesh.castShadow = true;
    this.scene.add(mesh);

    this.customers.push({
      mesh,
      type: isTakeout ? 'takeout' : 'dine-in',
      targetX: this.entrancePosition.x,
      targetZ: this.entrancePosition.z,
      speed: 2 + Math.random() * 1.5,
      state: 'entering',
      timer: 0.5 + Math.random(),
      assignedSeat: null,
      assignedSeatIdx: -1,
    });
  }

  // --- Animation loop ---
  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    const rawDelta = this.clock.getDelta();
    const delta = rawDelta * this.speedMultiplier;

    if (this.isActive) {
      this.updateCustomers(delta);
      this.updateStaff(delta);
      this.footfallTimer += delta;
      if (this.footfallTimer >= this.footfallInterval) {
        this.footfallTimer = 0;
        this.reportFootfall();
      }
    }
    this.updateDollarEffects(rawDelta);

    this.orbitControls.update();
    this.renderer.render(this.scene, this.camera);
  };

  // Derive per-zone people counts from current customer states so footfall
  // reflects what is actually happening in the scene.
  private reportFootfall(): void {
    if (!this.onFootfall) return;
    const zones: Record<string, number> = { entrance: 0, counter: 0, seating: 0 };
    for (const c of this.customers) {
      if (c.state === 'entering' || c.state === 'queuing' || c.state === 'leaving') zones['entrance']++;
      else if (c.state === 'ordering' || c.state === 'waiting-drink') zones['counter']++;
      else if (c.state === 'sitting') zones['seating']++;
    }
    for (const [zone, count] of Object.entries(zones)) {
      this.onFootfall(count, zone);
    }
  }

  private updateCustomers(delta: number): void {
    for (const customer of this.customers) {
      const dx = customer.targetX - customer.mesh.position.x;
      const dz = customer.targetZ - customer.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const arrived = dist < 0.4;

      // Move toward target
      if (!arrived) {
        const step = customer.speed * delta;
        customer.mesh.position.x += (dx / dist) * Math.min(step, dist);
        customer.mesh.position.z += (dz / dist) * Math.min(step, dist);
      }

      switch (customer.state) {
        case 'entering':
          if (arrived) {
            // Move to queue
            customer.state = 'queuing';
            const queueIdx = Math.min(this.customers.filter(c => c.state === 'queuing').length, this.queuePositions.length - 1);
            const qPos = this.queuePositions[queueIdx];
            customer.targetX = qPos.x;
            customer.targetZ = qPos.z;
            customer.timer = 1 + Math.random() * 2;
          }
          break;

        case 'queuing':
          if (arrived) {
            customer.timer -= delta;
            if (customer.timer <= 0) {
              // Move to counter to order
              customer.state = 'ordering';
              customer.targetX = this.counterPosition.x + (Math.random() - 0.5);
              customer.targetZ = this.counterPosition.z;
              customer.timer = 2 + Math.random() * 2;
            }
          }
          break;

        case 'ordering':
          if (arrived) {
            customer.timer -= delta;
            if (customer.timer <= 0) {
              // Transaction fires when order is placed
              if (this.onTransaction) {
                this.onTransaction(customer.type);
              }
              this.spawnDollarEffect(customer.mesh.position.x, customer.mesh.position.y, customer.mesh.position.z);

              // Move to pickup area
              customer.state = 'waiting-drink';
              customer.targetX = this.pickupPosition.x + (Math.random() - 0.5) * 2;
              customer.targetZ = this.pickupPosition.z;
              customer.timer = 3 + Math.random() * 3;
            }
          }
          break;

        case 'waiting-drink':
          if (arrived) {
            customer.timer -= delta;
            if (customer.timer <= 0) {
              if (customer.type === 'takeout') {
                // Takeout: grab and leave
                customer.state = 'leaving';
                customer.targetX = this.entrancePosition.x;
                customer.targetZ = this.entrancePosition.z;
              } else {
                // Dine-in: find a seat
                customer.state = 'sitting';
                const seatIdx = this.findAvailableSeat();
                if (seatIdx >= 0) {
                  this.occupiedSeats.add(seatIdx);
                  customer.assignedSeatIdx = seatIdx;
                  customer.assignedSeat = this.seatPositions[seatIdx];
                  customer.targetX = customer.assignedSeat.x;
                  customer.targetZ = customer.assignedSeat.z;
                  this.spawnTableClutter(seatIdx);
                  // Emit vision event: table occupied
                  this.emitTableEvent(seatIdx, 'occupied', 'simulator-vision');
                } else {
                  // No seats, leave as takeout
                  customer.state = 'leaving';
                  customer.targetX = this.entrancePosition.x;
                  customer.targetZ = this.entrancePosition.z;
                }
                customer.timer = 8 + Math.random() * 10; // dwell time
              }
            }
          }
          break;

        case 'sitting':
          if (arrived) {
            customer.timer -= delta;
            if (customer.timer <= 0) {
              // Done, leave — table stays dirty for staff to clear
              const idx = customer.assignedSeatIdx;
              if (idx >= 0) {
                this.occupiedSeats.delete(idx);
                this.dirtyTables.add(idx);
                // Simulate vision detection delay (1-4s) before reporting dirty
                setTimeout(() => {
                  this.emitTableEvent(idx, 'dirty', 'simulator-vision-camera');
                }, (1000 + Math.random() * 3000));
              }
              customer.state = 'leaving';
              customer.targetX = this.entrancePosition.x;
              customer.targetZ = this.entrancePosition.z;
            }
          }
          break;

        case 'leaving':
          if (arrived) {
            // Re-enter as new customer
            customer.mesh.position.set(
              this.entrancePosition.x + (Math.random() - 0.5) * 2,
              0.6,
              this.entrancePosition.z
            );
            customer.type = Math.random() < 0.6 ? 'takeout' : 'dine-in';
            (customer.mesh.material as THREE.MeshLambertMaterial).color.setHex(
              customer.type === 'takeout' ? 0xff9800 : 0x7b1fa2
            );
            customer.state = 'entering';
            customer.targetX = this.counterPosition.x;
            customer.targetZ = 0; // walk toward counter area
            customer.timer = 0.5 + Math.random();
            customer.assignedSeat = null;
            customer.assignedSeatIdx = -1;
          }
          break;
      }
    }
  }

  private findAvailableSeat(): number {
    const available: number[] = [];
    for (let i = 0; i < this.seatPositions.length; i++) {
      if (!this.occupiedSeats.has(i) && !this.dirtyTables.has(i)) {
        available.push(i);
      }
    }
    if (available.length === 0) return -1;
    return available[Math.floor(Math.random() * available.length)];
  }

  private spawnTableClutter(seatIdx: number): void {
    const pos = this.foodPositions[seatIdx];
    const group = new THREE.Group();

    // Coffee cup
    const cupMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const cupGeo = new THREE.CylinderGeometry(0.12, 0.1, 0.25, 8);
    const cup = new THREE.Mesh(cupGeo, cupMat);
    cup.position.set(0, 1.15, 0);
    group.add(cup);

    // Coffee liquid inside
    const liquidGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.02, 8);
    const liquidMat = new THREE.MeshLambertMaterial({ color: 0x4e342e });
    const liquid = new THREE.Mesh(liquidGeo, liquidMat);
    liquid.position.set(0, 1.27, 0);
    group.add(liquid);

    // Plate with pastry (random chance)
    if (Math.random() > 0.4) {
      const plateMat = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
      const plateGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 12);
      const plate = new THREE.Mesh(plateGeo, plateMat);
      plate.position.set(0.35, 1.06, 0.1);
      group.add(plate);

      // Pastry on plate
      const pastryGeo = new THREE.SphereGeometry(0.1, 6, 6);
      const pastryMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
      const pastry = new THREE.Mesh(pastryGeo, pastryMat);
      pastry.position.set(0.35, 1.15, 0.1);
      pastry.scale.set(1, 0.5, 1);
      group.add(pastry);
    }

    // Napkin (small flat box)
    if (Math.random() > 0.5) {
      const napkinGeo = new THREE.BoxGeometry(0.2, 0.01, 0.2);
      const napkinMat = new THREE.MeshLambertMaterial({ color: 0xfafafa });
      const napkin = new THREE.Mesh(napkinGeo, napkinMat);
      napkin.position.set(-0.25, 1.05, 0.2);
      napkin.rotation.y = Math.random() * Math.PI;
      group.add(napkin);
    }

    group.position.set(pos.x, 0, pos.z);
    this.scene.add(group);
    this.tableItems.set(seatIdx, group);
  }

  private removeTableClutter(seatIdx: number): void {
    const group = this.tableItems.get(seatIdx);
    if (group) {
      this.scene.remove(group);
      this.tableItems.delete(seatIdx);
    }
  }

  // --- Staff ---
  private spawnStaff(): void {
    // Remove existing staff
    for (const s of this.staff) {
      this.scene.remove(s.mesh);
    }
    this.staff = [];

    // 2 baristas behind the counter
    const baristaPositions = [
      new THREE.Vector3(2, 0, 10),
      new THREE.Vector3(5, 0, 10),
    ];
    baristaPositions.forEach(pos => {
      this.createStaffMember('barista', pos);
    });

    // Floor staff: 1 per 10 customers (minimum 1)
    const floorCount = Math.max(1, Math.ceil(this.customerCount / 10));
    for (let i = 0; i < floorCount; i++) {
      const homePos = new THREE.Vector3(-6 + i * 4, 0, 8);
      this.createStaffMember('floor', homePos);
    }
  }

  private createStaffMember(role: 'barista' | 'floor', homePosition: THREE.Vector3): void {
    const color = role === 'barista' ? 0x4caf50 : 0x2e7d32;
    const geo = new THREE.CapsuleGeometry(0.3, 0.6, 4, 8);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(homePosition.x, 0.6, homePosition.z);
    mesh.castShadow = true;
    this.scene.add(mesh);

    // Apron indicator (small box on front)
    const apronGeo = new THREE.BoxGeometry(0.25, 0.3, 0.05);
    const apronMat = new THREE.MeshLambertMaterial({ color: 0x1b5e20 });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.position.set(0, -0.1, 0.3);
    mesh.add(apron);

    this.staff.push({
      mesh,
      role,
      targetX: homePosition.x,
      targetZ: homePosition.z,
      speed: 2.5,
      state: 'idle',
      timer: 1 + Math.random() * 2,
      assignedDirtyTable: null,
      homePosition: homePosition.clone(),
    });
  }

  private updateStaff(delta: number): void {
    for (const staffMember of this.staff) {
      const dx = staffMember.targetX - staffMember.mesh.position.x;
      const dz = staffMember.targetZ - staffMember.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const arrived = dist < 0.4;

      // Move toward target
      if (!arrived) {
        const step = staffMember.speed * delta;
        staffMember.mesh.position.x += (dx / dist) * Math.min(step, dist);
        staffMember.mesh.position.z += (dz / dist) * Math.min(step, dist);
      }

      switch (staffMember.state) {
        case 'idle':
          // Baristas stay at their station, floor staff look for dirty tables
          if (staffMember.role === 'floor') {
            staffMember.timer -= delta;
            if (staffMember.timer <= 0) {
              // Check for a dirty table to clear
              const dirtyIdx = this.findDirtyTable();
              if (dirtyIdx >= 0) {
                staffMember.assignedDirtyTable = dirtyIdx;
                this.dirtyTables.delete(dirtyIdx); // claim it
                const pos = this.seatPositions[dirtyIdx];
                staffMember.targetX = pos.x;
                staffMember.targetZ = pos.z;
                staffMember.state = 'moving-to-table';
              } else {
                staffMember.timer = 1 + Math.random() * 2;
              }
            }
          } else {
            // Barista: small idle sway at station
            if (arrived) {
              staffMember.timer -= delta;
              if (staffMember.timer <= 0) {
                staffMember.targetX = staffMember.homePosition.x + (Math.random() - 0.5) * 2;
                staffMember.targetZ = staffMember.homePosition.z + (Math.random() - 0.5) * 1;
                staffMember.timer = 3 + Math.random() * 4;
              }
            }
          }
          break;

        case 'moving-to-table':
          if (arrived) {
            staffMember.state = 'clearing';
            staffMember.timer = 2 + Math.random(); // clearing time
          }
          break;

        case 'clearing':
          staffMember.timer -= delta;
          if (staffMember.timer <= 0) {
            // Remove the clutter
            if (staffMember.assignedDirtyTable !== null) {
              this.removeTableClutter(staffMember.assignedDirtyTable);
              // Emit vision event: table cleared
              this.emitTableEvent(staffMember.assignedDirtyTable, 'cleared', 'simulator-vision-camera');
              staffMember.assignedDirtyTable = null;
            }
            // Return to home position
            staffMember.state = 'returning';
            staffMember.targetX = staffMember.homePosition.x;
            staffMember.targetZ = staffMember.homePosition.z;
          }
          break;

        case 'returning':
          if (arrived) {
            staffMember.state = 'idle';
            staffMember.timer = 1 + Math.random() * 2;
          }
          break;
      }
    }
  }

  private findDirtyTable(): number {
    const dirty = Array.from(this.dirtyTables);
    if (dirty.length === 0) return -1;
    return dirty[Math.floor(Math.random() * dirty.length)];
  }

  /**
   * Emit a simulated vision event for a table state change.
   * Each seat index maps directly to one table (table-1, table-2, etc.)
   */
  private emitTableEvent(seatIdx: number, event: 'occupied' | 'dirty' | 'cleared', source: string): void {
    if (this.onTableEvent) {
      const tableId = `table-${seatIdx + 1}`;
      this.onTableEvent(tableId, event, source);
    }
  }

  // --- Dollar sign effect ---
  private createDollarTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#4caf50';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', 32, 32);
    return new THREE.CanvasTexture(canvas);
  }

  private spawnDollarEffect(x: number, y: number, z: number): void {
    const material = new THREE.SpriteMaterial({
      map: this.dollarTexture,
      transparent: true,
      opacity: 1,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y + 2, z);
    sprite.scale.set(1, 1, 1);
    this.scene.add(sprite);
    this.dollarEffects.push({ sprite, timer: 2, startY: y + 2 });
  }

  private updateDollarEffects(delta: number): void {
    for (let i = this.dollarEffects.length - 1; i >= 0; i--) {
      const effect = this.dollarEffects[i];
      effect.timer -= delta;
      effect.sprite.position.y += delta * 1.5;
      effect.sprite.material.rotation += delta * 4;
      effect.sprite.material.opacity = Math.max(0, effect.timer / 2);
      if (effect.timer <= 0) {
        this.scene.remove(effect.sprite);
        effect.sprite.material.dispose();
        this.dollarEffects.splice(i, 1);
      }
    }
  }

  // --- Interaction handlers ---
  private onPointerDown = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.selectableObjects, true);

    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj.parent && !this.selectableObjects.includes(obj)) {
        obj = obj.parent as THREE.Object3D;
      }
      if (this.selectableObjects.includes(obj)) {
        this.selectedObject = obj;
        this.transformControls.attach(obj);
      }
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key.toLowerCase()) {
      case 'g':
        this.transformControls.setMode('translate');
        break;
      case 'r':
        this.transformControls.setMode('rotate');
        break;
      case 's':
        this.transformControls.setMode('scale');
        break;
      case 'escape':
        this.transformControls.detach();
        this.selectedObject = null;
        break;
    }
  };

  private onResize = (): void => {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  // --- Public API ---
  setSimulationActive(active: boolean): void {
    this.isActive = active;
  }

  setCustomerCount(count: number): void {
    const target = Math.max(3, Math.min(30, count));
    if (target > this.customers.length) {
      for (let i = 0; i < target - this.customers.length; i++) {
        this.spawnCustomer();
      }
    } else if (target < this.customers.length) {
      const toRemove = this.customers.length - target;
      for (let i = 0; i < toRemove; i++) {
        const c = this.customers.pop()!;
        this.scene.remove(c.mesh);
      }
    }
    this.customerCount = target;
    this.spawnStaff();
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = Math.max(0.25, Math.min(5, multiplier));
  }

  reset(): void {
    for (const c of this.customers) {
      this.scene.remove(c.mesh);
    }
    for (const s of this.staff) {
      this.scene.remove(s.mesh);
    }
    this.customers = [];
    this.staff = [];
    this.occupiedSeats.clear();
    this.dirtyTables.clear();
    this.tableItems.forEach(group => this.scene.remove(group));
    this.tableItems.clear();
    this.spawnCustomers(this.customerCount);
    this.spawnStaff();
  }

  setFloorTableCount(count: number): void {
    const clamped = Math.max(1, Math.min(20, count));
    if (clamped === this.floorTableCount) return;
    this.floorTableCount = clamped;
    // Rebuild the seating area and bar (bar numbering depends on floor count)
    this.buildSeatingArea();
    this.buildWindowBar();
    // Notify listeners of the new total
    if (this.onTableCountChanged) {
      this.onTableCountChanged(this.totalTableCount);
    }
  }

  getFloorTableCount(): number {
    return this.floorTableCount;
  }

  /**
   * Restore table visual state from backend data.
   * Call after init() to sync scene with persisted table statuses.
   */
  restoreTableStates(tables: Record<string, { status: string }>): void {
    for (const [id, data] of Object.entries(tables)) {
      const num = parseInt(id.replace('table-', ''));
      if (isNaN(num) || num < 1) continue;
      const seatIdx = num - 1; // table-1 → index 0
      if (seatIdx >= this.seatPositions.length) continue;

      if (data.status === 'occupied') {
        this.occupiedSeats.add(seatIdx);
        this.spawnTableClutter(seatIdx);
        this.spawnSeatedCustomer(seatIdx);
      } else if (data.status === 'dirty') {
        this.dirtyTables.add(seatIdx);
        this.spawnTableClutter(seatIdx);
      }
    }
  }

  /**
   * Spawn a customer already seated at a table (for state restoration).
   */
  private spawnSeatedCustomer(seatIdx: number): void {
    const pos = this.seatPositions[seatIdx];
    const geo = new THREE.CapsuleGeometry(0.3, 0.6, 4, 8);
    const mat = new THREE.MeshLambertMaterial({ color: 0x7b1fa2 }); // purple = dine-in
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, 0.6, pos.z);
    mesh.castShadow = true;
    this.scene.add(mesh);

    this.customers.push({
      mesh,
      type: 'dine-in',
      targetX: pos.x,
      targetZ: pos.z,
      speed: 2 + Math.random() * 1.5,
      state: 'sitting',
      timer: 5 + Math.random() * 8, // remaining dwell time
      assignedSeat: pos,
      assignedSeatIdx: seatIdx,
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.animationId);
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('keydown', this.onKeyDown);
    this.transformControls.detach();
    this.transformControls.dispose();
    this.orbitControls.dispose();
    this.renderer.dispose();
  }
}

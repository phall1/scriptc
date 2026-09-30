/// <reference path="./three-host.d.ts" />
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import { MeshNormalMaterial } from 'three/src/materials/MeshNormalMaterial.js';
import { Vector3 } from 'three/src/math/Vector3.js';


const camera = new PerspectiveCamera(70, 1, 0.01, 10);
camera.position.z = 1;
const scene = new Scene();
const geometry = new BoxGeometry(0.2, 0.2, 0.2);
const mesh = new Mesh(geometry, new MeshNormalMaterial());
scene.add(mesh);
const point = new Vector3();

/** @param {number} time @param {number} aspect @returns {number} */
export function frame(time, aspect) {
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  mesh.rotation.x = time / 2000;
  mesh.rotation.y = time / 1000;
  scene.updateMatrixWorld(true);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).project(camera);
    vertex(i, point.x, point.y, point.z);
  }
  return Number(position.count);
}

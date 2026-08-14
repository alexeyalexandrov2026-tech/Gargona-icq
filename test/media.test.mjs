import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAllowedContentType, mediaObjectName, mediaKey, mediaPath } from "../src/media.js";

const ROOM_ID = "2f1b1e2a-52b0-4a90-9f0a-1234567890ab";
const PARTICIPANT_ID = "9c8d7e6f-5432-4a90-8b1c-abcdef012345";
const OBJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("isAllowedContentType", () => {
  test("accepts the supported image/video types", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "video/webm", "video/mp4"]) {
      assert.equal(isAllowedContentType(type), true, type);
    }
  });

  test("rejects everything else, including scripty/executable types", () => {
    for (const type of ["text/html", "application/javascript", "application/x-msdownload", "image/svg+xml", ""]) {
      assert.equal(isAllowedContentType(type), false, type);
    }
  });
});

describe("mediaObjectName", () => {
  test("builds <uuid>.<ext> for a valid id + content type", () => {
    assert.equal(mediaObjectName(OBJECT_ID, "image/jpeg"), `${OBJECT_ID}.jpg`);
    assert.equal(mediaObjectName(OBJECT_ID, "video/webm"), `${OBJECT_ID}.webm`);
  });

  test("refuses a non-UUID object id", () => {
    assert.equal(mediaObjectName("../../etc/passwd", "image/jpeg"), null);
  });

  test("refuses an unsupported content type", () => {
    assert.equal(mediaObjectName(OBJECT_ID, "text/html"), null);
  });
});

describe("mediaKey (R2 object key construction / path-traversal resistance)", () => {
  test("builds room/participant/object.ext for well-formed input", () => {
    const objectName = mediaObjectName(OBJECT_ID, "image/jpeg");
    assert.equal(mediaKey(ROOM_ID, PARTICIPANT_ID, objectName), `${ROOM_ID}/${PARTICIPANT_ID}/${objectName}`);
  });

  test("refuses a roomId that is not a UUID", () => {
    const objectName = mediaObjectName(OBJECT_ID, "image/jpeg");
    assert.equal(mediaKey("../../secrets", PARTICIPANT_ID, objectName), null);
  });

  test("refuses a participantId that is not a UUID", () => {
    const objectName = mediaObjectName(OBJECT_ID, "image/jpeg");
    assert.equal(mediaKey(ROOM_ID, "../../secrets", objectName), null);
  });

  test("refuses an objectName that does not match <uuid>.<ext>", () => {
    for (const bad of ["../escape.jpg", "no-extension", "..%2f..%2fetc.jpg", "sub/dir.jpg"]) {
      assert.equal(mediaKey(ROOM_ID, PARTICIPANT_ID, bad), null, bad);
    }
  });
});

describe("mediaPath (public download URL path)", () => {
  test("matches the shape the download route regex expects", () => {
    const objectName = mediaObjectName(OBJECT_ID, "image/png");
    const path = mediaPath(ROOM_ID, PARTICIPANT_ID, objectName);
    assert.equal(path, `/api/media/${ROOM_ID}/${PARTICIPANT_ID}/${objectName}`);
    assert.match(path, /^\/api\/media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]+$/i);
  });
});

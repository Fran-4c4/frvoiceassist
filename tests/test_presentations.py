import pytest

from app.presentations import PresentationData, PresentationItem, PresentationStore


@pytest.fixture
def store(tmp_path):
    return PresentationStore(tmp_path / "presentations")


def test_crud(store):
    items = [PresentationItem(title="Intro", text="Hi.")]
    p = store.create(PresentationData(title="Quarterly — Review 6.3!", items=items))
    assert p.id.startswith("quarterly-review-6-3-")
    assert store.get(p.id).items[0].text == "Hi."
    assert store.list()[0]["items"] == 1

    updated = store.update(p.id, PresentationData(title="Renamed", clone_mode="timbre", items=[]))
    assert updated.title == "Renamed" and updated.clone_mode == "timbre" and updated.items == []
    store.delete(p.id)
    assert store.list() == []
    with pytest.raises(KeyError):
        store.get(p.id)


def test_items_get_ids(store):
    p = store.create(PresentationData(title="x", items=[PresentationItem(text="a"), PresentationItem(text="b")]))
    ids = [i.id for i in p.items]
    assert all(ids) and len(set(ids)) == 2


@pytest.mark.parametrize("bad", ["../secret", "", "UPPER", "a/b"])
def test_rejects_bad_ids(store, bad):
    with pytest.raises(KeyError):
        store.get(bad)


def test_api_presentations(client):
    body = {"title": "Demo", "voice": "me", "items": [{"title": "Slide 1", "text": "Hello. How are you?"}]}
    created = client.post("/api/presentations", json=body)
    assert created.status_code == 201
    pid = created.json()["id"]
    assert client.get("/api/presentations").json()[0]["id"] == pid
    got = client.get(f"/api/presentations/{pid}").json()
    assert got["items"][0]["title"] == "Slide 1"

    got["items"].append({"title": "Slide 2", "text": "Bye."})
    put = client.put(f"/api/presentations/{pid}", json=got)
    assert put.status_code == 200 and len(put.json()["items"]) == 2

    assert client.delete(f"/api/presentations/{pid}").status_code == 204
    assert client.get(f"/api/presentations/{pid}").status_code == 404
    assert client.put(f"/api/presentations/{pid}", json=got).status_code == 404
    assert client.post("/api/presentations", json={"title": ""}).status_code == 422

// Installed production RPCs, isolated synthetic rows, mandatory rollback.
// No OAuth/Spotify calls, no owner purge, no persisted fake playlist or annotation.
import {
  type CoreRegistry,
  insertFixturesSql,
  validateRegistry,
} from "./core-fixtures.ts";
export function fastProofSql(r: CoreRegistry): string {
  validateRegistry(r);
  const [a, b] = r.tagIds, [x, y, z] = r.trackKeys;
  const filter = JSON.stringify({
    membership: "active",
    search: "",
    untagged: false,
    newOnly: false,
    artistId: r.artistId,
  });
  const assert = (expression: string, label: string) =>
    `perform pg_temp.fast_assert(${expression},'${label}'); assertion_count:=assertion_count+1;`;
  return `do $proof$ declare f jsonb:='${filter}'; page jsonb; groups jsonb; selection jsonb; rev jsonb; first_action jsonb; result jsonb; q jsonb; assertion_count integer:=0; begin
    begin
      create function pg_temp.fast_assert(ok boolean,label text) returns void language plpgsql as $fn$ begin if ok is distinct from true then raise exception 'fast_%',label; end if; end $fn$;
      ${
    insertFixturesSql(r).replace(/^do \$fixture\$ begin /, "").replace(
      /end \$fixture\$; select true as ok;$/,
      " ",
    )
  }
      insert into app.sessions(token_hash,epoch,expires_at) values('${x}',${r.epoch},now()+interval '1 hour');
      page:=public.app_library_search(${r.epoch},jsonb_build_object('filter',f,'groupBy',null,'sort','oldest','limit',1,'cursor',null));
      ${
    assert(
      `page->>'totalTracks'='2' and page->'tracks'->0->>'trackKey'='${x}' and page->>'nextCursor' is not null`,
      "filter_sort_paging",
    )
  }
      ${
    assert(
      `public.app_library_search(${r.epoch},jsonb_build_object('filter',f,'groupBy',null,'sort','oldest','limit',1,'cursor',page->>'nextCursor'))->'tracks'->0->>'trackKey'='${y}'`,
      "page_continuation",
    )
  }
      groups:=public.app_library_search(${r.epoch},jsonb_build_object('filter',f,'groupBy','album','limit',100,'cursor',null));
      ${
    assert(
      `groups->>'totalGroups'='1' and groups->'groups'->0->>'trackCount'='2' and cardinality(app.selection_keys(${r.epoch},groups->'groups'->0->'selection'))=2`,
      "group_selection",
    )
  }
      ${
    assert(
      `public.app_library_facets(${r.epoch},jsonb_build_object('filter',f,'facet','decade','cursor',null,'limit',100))->'options'->0->>'trackCount'='2'`,
      "facet_count",
    )
  }
      selection:=jsonb_build_object('kind','filter','filter',f,'expectedRevision',app.library_revision());
      first_action:=public.app_tag_action(${r.epoch},'${x}',jsonb_build_object('action','add','tagId','${a}','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array('${x}'))));
      ${assert(`first_action->>'changedCount'='1'`, "immediate_assignment")}
      rev:=app.library_revision();
      result:=public.app_tags_selection(${r.epoch},jsonb_build_object('selection',jsonb_build_object('kind','filter','filter',f,'expectedRevision',rev),'tagIds',jsonb_build_array('${a}','${b}'),'expectedRevision',rev));
      ${
    assert(
      `result->'tags'->0->>'state'='some' and result->'tags'->1->>'state'='none'`,
      "tri_state",
    )
  }
      result:=public.app_tag_action(${r.epoch},'${x}',jsonb_build_object('action','add','tagId','${a}','selection',jsonb_build_object('kind','filter','filter',f,'expectedRevision',rev)));
      ${
    assert(
      `result->>'selectedCount'='2' and result->>'changedCount'='1'`,
      "bulk_changed_only",
    )
  }
      -- A volatile mutation and a table read must use separate SQL statements:
      -- the enclosing statement's MVCC snapshot can predate the mutation.
      result:=public.app_tag_undo(${r.epoch},'${x}',(result->>'actionId')::uuid);
      ${
    assert(
      `result->>'restoredCount'='1' and (select count(*)=1 from app.track_tags where tag_id='${a}' and present)`,
      "undo_preserves_preexisting",
    )
  }
      begin perform app.selection_keys(${r.epoch},selection); raise exception 'fast_stale_selection_accepted'; exception when raise_exception then if sqlerrm<>'stale_revision' then raise; end if; end; assertion_count:=assertion_count+1;
      ${
    assert(
      `public.app_tag_create(${r.epoch},'  TAGGER API TEST ${r.run}   0 ')->'tag'->>'id'='${a}'`,
      "normalized_identity",
    )
  }
      ${
    assert(
      `public.app_tags_search(${r.epoch},'Tagger API test ${r.run} 0',10)->'tags'->0->>'id'='${a}'`,
      "autocomplete_exact",
    )
  }
      result:=public.app_tags_manage(${r.epoch},'${x}',jsonb_build_object('action','rename','tagId','${a}','name','Café 🎷 / 2 ${r.run}','expectedRevision',app.library_revision()));
      ${
    assert(
      `result->>'changedCount'='1' and (select name='Café 🎷 / 2 ${r.run}' from app.tags where id='${a}')`,
      "rename_unicode",
    )
  }
      ${
    assert(
      `public.app_tag_undo(${r.epoch},'${x}',(result->>'actionId')::uuid)->>'skippedCount'='0'`,
      "rename_undo",
    )
  }
      result:=public.app_tags_manage(${r.epoch},'${x}',jsonb_build_object('action','rename','tagId','${b}','name','Tagger API test ${r.run} 0','expectedRevision',app.library_revision()));
      ${
    assert(
      `result->>'changedCount'='0' and result->'collisionTag'->>'id'='${a}'`,
      "collision_offers_merge",
    )
  }
      perform public.app_tag_action(${r.epoch},'${x}',jsonb_build_object('action','add','tagId','${b}','selection',jsonb_build_object('kind','tracks','trackKeys',jsonb_build_array('${x}','${y}','${z}'))));
      q:=jsonb_build_object('version',1,'root',jsonb_build_object('op','not','child',jsonb_build_object('op','tag','tagId','${b}')));
      insert into app.playlists(id,epoch,name,query,retention,track_count,status) values('${r.requestId}',${r.epoch},'Synthetic query reference',q,'pinned',0,'ready');
      result:=public.app_tags_manage_preview(${r.epoch},jsonb_build_object('action','merge','sourceIds',jsonb_build_array('${b}'),'targetId','${a}','expectedRevision',app.library_revision()));
      ${
    assert(
      `result->>'unionCount'='3' and result->>'activeTrackCount'='2' and result->>'assignmentCount'='4'`,
      "exact_merge_union",
    )
  }
      result:=public.app_tags_manage(${r.epoch},'${x}',jsonb_build_object('action','merge','sourceIds',jsonb_build_array('${b}'),'targetId','${a}','expectedRevision',app.library_revision()));
      ${
    assert(
      `(select query->'root'->'child'->>'tagId'='${a}' and track_count=0 from app.playlists where id='${r.requestId}')`,
      "nested_query_identity",
    )
  }
      perform public.app_tag_undo(${r.epoch},'${x}',(result->>'actionId')::uuid);
      ${
    assert(
      `(select query=q from app.playlists where id='${r.requestId}') and (select count(*)=3 from app.track_tags where tag_id='${b}' and present)`,
      "merge_undo_query_edges",
    )
  }
      result:=public.app_tags_manage(${r.epoch},'${x}',jsonb_build_object('action','delete','tagId','${b}','confirmedAssignmentCount',3,'expectedRevision',app.library_revision()));
      begin perform app.validate_query(q); raise exception 'fast_deleted_query_accepted'; exception when raise_exception then if sqlerrm<>'unknown_tag' then raise; end if; end; assertion_count:=assertion_count+1;
      ${
    assert(
      `public.app_tag_undo(${r.epoch},'${x}',(result->>'actionId')::uuid)->>'restoredCount'='3'`,
      "delete_session_undo",
    )
  }
      perform app.validate_query(q); assertion_count:=assertion_count+1;
      if assertion_count<>20 then raise exception 'fast_assertion_count_incomplete'; end if;
      raise exception using errcode='ZX001',message='synthetic_rollback';
    exception when sqlstate 'ZX001' then null; end;
    if exists(select 1 from app.annotations where track_key in ('${x}','${y}','${z}')) or exists(select 1 from app.tags where id in ('${a}','${b}')) or exists(select 1 from app.sessions where token_hash='${x}') or exists(select 1 from app.playlists where id='${r.requestId}') then raise exception 'fast_rollback_failed'; end if;
  end $proof$; select true as transactionalFastTagging, true as fixturesRolledBack, 20 as assertions;`;
}
